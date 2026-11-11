# Teste de carga

Diferencial opcional da seção 14. O objetivo não é bater uma meta de RPS. É medir com honestidade como a solução se comporta sob carga concorrente, onde está o gargalo e o que acontece com as garantias (idempotência, saldo == ledger, outbox).

## Como rodar

Com o ambiente no ar (`docker compose up --build -d --wait`, 3 instâncias):

```bash
# gerador dentro da rede do compose (medição principal)
bun run test:load:compose

# gerador no host, pelas portas publicadas
bun run test:load
```

Parâmetros por variável de ambiente: `LOAD_DURATION_S` (20), `LOAD_CONCURRENCY` (32), `LOAD_WALLETS` (100) e `LOAD_SQS_MESSAGES` (2000). Cada execução grava `load-test-results/<data>.md` e `.json`. O script está em [test/load/load-test.ts](test/load/load-test.ts).

## Ambiente

| Item | Valor |
|---|---|
| Máquina | AMD Ryzen 5 4600G (6 núcleos / 12 threads), 32 GB RAM, Windows 11 |
| Docker | Docker Desktop (WSL2), 12 CPUs e 15,3 GB para a VM |
| Banco | PostgreSQL 17 (imagem `postgres:17-alpine`, configuração padrão, volume Docker) |
| Fila | LocalStack 4.4 (SQS) |
| Aplicação | 3 instâncias (`app` + 2 `worker`), Bun 1.4.4, pool de 10 conexões cada, workers ligados |
| Gerador | o mesmo `bun`, na mesma máquina |

**Atenção:** tudo roda na mesma máquina. Gerador, 3 instâncias, PostgreSQL e LocalStack disputam os mesmos 12 threads, então os números são um limite inferior e não devem ser extrapolados para produção.

## Metodologia

Antes dos cenários, são criadas 100 wallets e uma "hot wallet", todas com saldo de 1.000.000,00 (para não haver rejeição por saldo). Os três cenários rodam em sequência:

1. **http-distributed**: 32 clientes concorrentes por 20 s, em round-robin entre as 3 instâncias. Cada requisição escolhe uma das 100 wallets ao acaso: 80% são BET e 20% WIN, de 1.00. 5% das requisições são **reenvio idêntico** de uma requisição anterior (mesma chave e mesmo corpo), e devem voltar como replay.
2. **http-hot-wallet**: 32 clientes por 10 s, **todos na mesma wallet**. É o pior caso para o lock por wallet.
3. **sqs-throughput**: 2.000 mensagens BET 1.00 enfileiradas de uma vez (cerca de 2,5 s), espalhadas pelas 100 wallets (`MessageGroupId` = wallet), e consumidas pelas 3 instâncias.

O que é medido:
- **Latência:** do ponto de vista do cliente. No cenário SQS, vai do envio à fila até o commit, então inclui o tempo de espera na fila.
- **Taxa de erro:** respostas 5xx, falhas de rede e 4xx inesperados. O 422 é regra de negócio e não conta como erro.
- **Contadores:** conflitos de lock, retries, duplicatas, DLQ e eventos publicados, somados das métricas Prometheus das 3 instâncias (diferença entre antes e depois).
- **Outbox lag:** amostrado direto no banco a cada 250 ms (idade do evento pendente mais antigo), mais o tempo para a outbox zerar depois que a carga para.
- **Invariante:** ao final, `saldo == ledger` é verificado no banco para todas as 101 wallets usadas.

## Resultados

Medição principal, com o gerador dentro da rede do compose ([relatório](load-test-results/2026-11-11T10-38-58.md)):

| Cenário | Req. | Throughput | p50 | p95 | p99 | máx | Erros | Outbox lag máx / p95 | Drenagem |
|---|---|---|---|---|---|---|---|---|---|
| http-distributed | 3.785 | **188 req/s** | 153 ms | 326 ms | 485 ms | 759 ms | 0,00% | 0,90 s / 0,74 s | 0,1 s |
| http-hot-wallet | 655 | **63 req/s** | 515 ms | 689 ms | 757 ms | 832 ms | 0,00% | 0,73 s / 0,48 s | 0 s |
| sqs-throughput | 2.000 | **89 msg/s** | 10,7 s* | 19,1 s* | 19,8 s* | 20,0 s* | 0,00% | 1,02 s / 0,77 s | 0,4 s |

Repetição com o gerador no host ([relatório](load-test-results/2026-11-11T10-40-02.md)):

| Cenário | Throughput | p50 | p95 | p99 | Erros |
|---|---|---|---|---|---|
| http-distributed | 195 req/s | 156 ms | 305 ms | 384 ms | 0,00% |
| http-hot-wallet | 71 req/s | 472 ms | 641 ms | 681 ms | 0,00% |
| sqs-throughput | 101 msg/s | 9,8 s* | 17,1 s* | 17,5 s* | 0,00% |

\* No cenário SQS, as 2.000 mensagens entram na fila em cerca de 2,5 s, mas são consumidas em cerca de 20 s. A "latência" mede quanto tempo a mensagem esperou nesse backlog, não o custo de processar uma mensagem.

**Garantias sob carga** (as duas execuções):
- **Erros:** 0 erros, 0 timeouts de lock, 0 retries, 0 mensagens na DLQ.
- **Idempotência:** 185 de 185 reenvios idênticos no cenário distribuído (e 33 de 33 no da hot wallet) voltaram com `idempotentReplay: true`, e nenhum gerou débito duplicado.
- **Invariante:** `saldo == ledger` nas 101 wallets, 0 inconsistências.
- **Outbox:** 12.545 eventos publicados, lag máximo de cerca de 1 s, zerando em menos de 0,5 s depois que a carga parou.

## Análise

### Onde está o gargalo

A primeira rodada exploratória (5 s, 20 wallets) deu números bem mais baixos, então investiguei antes de aceitar qualquer conclusão. Eliminei hipóteses uma a uma, com medições isoladas:

| Hipótese | Experimento | Resultado |
|---|---|---|
| Logs em stdout | `LOG_LEVEL=info` vs `warn` | sem diferença (98 vs 96 tx/s) |
| Pool de conexões | pool 5, 10 e 30 | 98, 104 e 116 tx/s: quase não muda |
| fsync do commit (WAL) | `synchronous_commit=off` no servidor, por alguns segundos | 145 → 157 tx/s, dentro do ruído |
| Driver `pg` no Bun | `select $1` sequencial, `pg` vs `Bun.SQL` nativo | 0,32 vs 0,35 ms/consulta: iguais |
| knex / MikroORM puros | consulta crua via knex e `em.execute` | 0,4–0,7 ms/consulta; transação vazia 2,3 ms |
| Port-forwarding do host | mesmo teste dentro e fora da rede do compose | 188 vs 195 req/s: não é o gargalo |

O que explicou foi o log de duração por comando do PostgreSQL (`log_min_duration_statement=0`, ligado só durante a medição):
- uma aposta gasta cerca de **6 ms dentro do PostgreSQL**: o `COMMIT` leva cerca de 2 ms, por causa dos triggers *deferred* e das FKs, e cada INSERT/SELECT de 0,3 a 0,7 ms;
- de ponta a ponta, a mesma aposta leva **cerca de 17 ms**;
- a diferença está nos **intervalos de cerca de 2 ms entre um comando e o seguinte**. Nesse tempo, o MikroORM monta a consulta, hidrata entidades, mantém o identity map e calcula o change set, tudo na única thread JavaScript do processo.

Ou seja: **cada instância fica limitada pela CPU gasta no ORM** (cerca de 100–150 tx/s por processo neste ambiente), e não pelo banco. No teste de carga, os containers da aplicação chegaram a cerca de 140–150% de CPU cada (a thread JS mais o GC e o I/O do Bun), enquanto o PostgreSQL ainda tinha folga.

A consequência é boa: **o throughput escala horizontalmente**. Três instâncias fizeram cerca de 190 req/s com wallets distribuídas, mesmo dividindo a CPU com o banco, o LocalStack e o próprio gerador. Nenhum lock global impede adicionar instâncias. Para comparação, uma transação de formato parecido em SQL puro chega a cerca de 540 tx/s neste mesmo PostgreSQL, então ainda há margem no banco.

**Otimização aplicada durante o experimento:** reduzi de 10 para 8 os comandos SQL de cada aposta:
- o `lock_timeout` passou a ser configurado uma única vez por conexão, em vez de um `SET LOCAL` por transação;
- as buscas de duplicata, pela chave de idempotência e pelo id externo, viraram uma consulta só.

As garantias não mudaram, e há um teste novo para o caminho de `LOCK_TIMEOUT`. **O ganho não foi mensurável acima do ruído** (as rodadas variam ±25%). Fica registrado assim, sem número inventado.

### Hot wallet: o custo do lock por wallet

Com todos os clientes na mesma wallet, as transações daquela wallet ficam **em série**: a capacidade é 1 ÷ (tempo com o lock), e o resto espera. Com 63–71 req/s, cada operação segura o lock por cerca de 15 ms, que é a própria duração da transação. A latência cresce com a fila: 32 clientes × 15 ms ≈ 480 ms, o que bate com o p50 medido (472–515 ms).

Esse é o trade-off consciente do lock pessimista (ARCHITECTURE.md, seção 6):
- **o que se ganha:** zero conflitos, zero retries e nenhum lost update;
- **o que se perde:** throughput por wallet limitado pela latência da transação.

Para uma wallet de jogador real, que faz algumas operações por segundo, isso sobra. Se uma wallet compartilhada (ex.: um jackpot) precisasse de milhares de operações por segundo, o caminho seria reduzir o tempo com o lock (menos comandos dentro da transação, ou um driver sem ORM no caminho crítico) ou particionar o saldo.

Não houve nenhum `LOCK_TIMEOUT`: a maior espera (832 ms) ficou bem abaixo do limite de 5 s.

### SQS

O consumo ficou em 89–101 msg/s, abaixo do HTTP. Três razões, todas de desenho e não de correção:
1. Cada instância tem **um loop de polling** que recebe até 10 mensagens e só busca o próximo lote quando o atual termina, então a concorrência é de até 10 por instância, contra 32 no HTTP.
2. Dentro do lote, mensagens do mesmo `MessageGroupId` (mesma wallet) são processadas em ordem, e o lote espera o grupo mais lento.
3. O LocalStack usou bastante CPU (picos de cerca de 160%) para atender o long polling das 3 instâncias e a publicação da outbox.

Melhorias possíveis: vários loops de polling por instância (configurável) e não esperar o lote inteiro para buscar o próximo. O FIFO por wallet continuaria garantido pelo próprio SQS.

### Outbox

Mesmo com cerca de 400 eventos/s sendo gerados (cada aposta gera 2 eventos), o lag máximo ficou em cerca de 1 s e a outbox zerou em menos de 0,5 s depois da carga. Os 3 publishers com `SKIP LOCKED` dão conta sem disputa entre si. O lag observado é dominado pelo intervalo de polling quando a fila esvazia (`WORKER_IDLE_DELAY_MS=1000`).

## Limitações do experimento

- **Tudo na mesma máquina:** o gerador disputa CPU com o sistema medido.
- **Rodadas curtas** (10–20 s) e sem aquecimento separado; a variação entre rodadas foi de cerca de ±25%.
- **Volume pequeno** e sem tráfego misto de reversões (REFUND/ROLLBACK) ou de transações fora de ordem.
- **PostgreSQL com configuração padrão**, rodando dentro da VM do Docker Desktop. Em produção, o disco e a rede seriam outros.
- **A latência do SQS mede o esvaziamento de um backlog**, não a latência de uma mensagem isolada.
