# Arquitetura e decisões

Este documento explica **como** o processador de apostas garante as invariantes do desafio e **por que** cada escolha foi feita. As limitações conhecidas estão no final, sem maquiagem.

## 1. Visão geral

```
              HTTP (provedores)                     SQS wager-transactions.fifo
                     │                                          │
          WageringController                       WagerTransactionConsumer
                     │                                          │ (inbox)
                     └──────────────► WagerTransactionService ◄─┘   ← mesmo caso de uso
                                             │
                     ┌───────────────────────┼───────────────────────┐
                     │      UMA transação PostgreSQL por operação     │
                     │  SELECT wallet FOR UPDATE                      │
                     │  inbox · idempotência · WagerSettlement        │
                     │  INSERT transação + ledger · UPDATE wallet     │
                     │  INSERT outbox                                 │
                     └───────────────────────┬───────────────────────┘
                                             │ commit
              OutboxPublisher (SKIP LOCKED) ─┴─► SQS wagering-events.fifo
              PendingReferenceWorker ──► reavalia PENDING_REFERENCE vencidas
```

Toda instância roda a API e os três workers. No `docker compose` sobem três instâncias (`app` + 2 × `worker`) disputando o mesmo banco e as mesmas filas.

## 2. Camadas

| Camada | Pasta | Depende de |
|---|---|---|
| Domínio | `src/domain` | nada (nem NestJS, nem ORM) |
| Aplicação | `src/application` | domínio + **portas** (`ports.ts`) |
| Infraestrutura | `src/infrastructure` | MikroORM, AWS SDK; implementa as portas |
| Interfaces | `src/interfaces` | adaptadores de entrada: HTTP e SQS |

- O domínio tem construtores privados, factories (`create`, `open`, `opening`, `rehydrate`) e estado encapsulado. `rehydrate` não revalida transições.
- As regras de negócio da seção 7 ficam num serviço de domínio puro, `WagerSettlement`. Ele recebe a transação, a wallet já travada e a referência, e não faz I/O. Por isso as regras são testadas em memória (`test/unit/wager-settlement.test.ts`).
- A aplicação conhece só `WageringStore.transaction(work)`. Quem abre a transação SQL, trava linhas e converte erros do driver é a infraestrutura.

## 3. ORM: MikroORM

**Escolha:** MikroORM (preferencial no desafio). O Unit of Work explícito encaixa no modelo "carrega, muda o domínio, grava tudo no commit". `em.transactional()` e `LockMode` dão o controle transacional necessário.

**Mapeamento:** as tabelas são mapeadas com `EntitySchema` para classes de *record* (`records.ts`). Os mappers (`mappers.ts`) convertem record ↔ domínio usando as factories. As classes de domínio não carregam decorators nem tipos do ORM. O custo é um mapper a mais por agregado, e em troca as invariantes ficam em classes que não dependem de framework.

**Estratégia transacional** (`MikroOrmWageringStore`):
- Cada operação usa `em.fork()`, ou seja, Unit of Work e Identity Map próprios. Isso vale também fora de requisição HTTP (workers). `allowGlobalContext` fica `false`.
- `em.transactional()` dá o flush automático no commit. O `lock_timeout` (padrão 5 s, `DATABASE_LOCK_TIMEOUT_MS`) é configurado uma vez em cada conexão do pool (`afterCreate`), e não com um `SET LOCAL` por transação: é uma ida e volta a menos ao banco por operação.
- Uma aposta executa 8 comandos: `BEGIN`, `SELECT … FOR UPDATE` da wallet, uma busca de duplicatas (chave **ou** id externo), INSERTs de outbox, ledger e transação, `UPDATE` da wallet e `COMMIT`.
- As FKs são `DEFERRABLE INITIALLY DEFERRED`. Assim a ordem dos INSERTs escolhida pelo Unit of Work não importa, e a integridade é checada no commit.
- Exceções do driver viram erros de aplicação: `UniqueViolationError` e `TransientInfrastructureError` (`LOCK_TIMEOUT`/`TRANSIENT_FAILURE`). Nenhum tipo do ORM sai da infraestrutura.

**Money no banco:** `NUMERIC(20,2)` para valores e saldos, e `CHAR(3)` para a moeda, em colunas separadas. O driver devolve string, e `moneyFromNumeric` converte string → centavos `bigint` sem passar por `number`.

## 4. Money

- Guarda **centavos em `bigint`**. Soma e subtração são exatas e não há dependência de biblioteca decimal.
- A entrada exige **exatamente 2 casas** (`"25.00"`). Por construção, a regex recusa sinal, notação científica, `NaN`, `Infinity`, vírgula, espaços e zeros à esquerda. O limite é de 18 dígitos inteiros, para caber em `NUMERIC(20,2)`.
- **Não existe arredondamento.** Como só há soma e subtração, com escala fixa de 2 e entradas com mais casas recusadas, nenhuma operação produz frações de centavo. Os testes cobrem `0.10 + 0.20 = 0.30` e valores acima de `Number.MAX_SAFE_INTEGER`.
- Valor negativo só aparece internamente (resultado de `subtract`/`negate`). `Money.from` (contrato de entrada) recusa negativos.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`. O sistema é multi-moeda (uma wallet por player **e moeda**), e os testes usam BRL e USD.

## 5. Modelo e transições

```
PENDING ──────────┬──> PROCESSED
   │              ├──> REJECTED
   │              └──> FAILED
   └──> PENDING_REFERENCE ──(nova tentativa)──> PENDING_REFERENCE
                  ├──> PROCESSED
                  ├──> REJECTED   (inclusive REFERENCE_NOT_FOUND ao esgotar)
                  └──> FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais. Tentar sair deles lança `InvalidTransactionStateError`, que é erro de programação (500), não regra de negócio. No banco, um trigger impede alterar uma linha terminal.

`Wallet.debit`/`credit` são a **única** forma de mudar o saldo, e ambas devolvem o `WalletLedgerEntry` correspondente. A `version` começa em 1 e só incrementa quando o saldo muda. Todo lançamento grava a versão resultante (`wallet_version`).

## 6. Concorrência

**Estratégia: lock pessimista por wallet**, com `SELECT … FOR UPDATE` na linha da wallet no início de toda operação que pode mexer nela.

Por que pessimista e não otimista:
- **Wallet disputada.** Com lock otimista, N requisições simultâneas na mesma wallet geram N−1 conflitos, que voltam como retry e competem de novo. O pessimista simplesmente enfileira no banco: cada operação segura o lock por poucos milissegundos.
- **Idempotência fica simples.** Como a wallet é travada *antes* da busca por idempotency key, duplicatas da mesma wallet são serializadas, e a segunda sempre enxerga a primeira já commitada. Não há janela entre "verifiquei que não existe" e "inseri".
- **Sem deadlock.** Cada transação trava exatamente uma wallet, então não existe ciclo de espera.
- **Sem lock global.** Wallets diferentes são linhas diferentes e andam em paralelo, como mostra o teste com 10 wallets × 10 apostas.

`lock_timeout = 5s`: esperar mais que isso indica wallet patologicamente disputada ou banco degradado. Nesse caso a resposta é `503 LOCK_TIMEOUT`, com retry seguro, e a métrica `wagering_lock_conflicts_total` é incrementada (teste `lock contention`).

**Custo medido** ([LOAD_TEST.md](LOAD_TEST.md)): numa wallet extremamente disputada, as operações ficam em série. Foram cerca de 65 operações/s nessa wallet, com p50 de cerca de 500 ms para 32 clientes simultâneos, e zero conflitos ou retries. Wallets diferentes escalam com o número de instâncias.

**Defesa em profundidade no banco.** Mesmo que o código tivesse um bug de concorrência, o schema não deixa corromper:
- `CHECK (balance >= 0)`;
- `UNIQUE (wallet_id, wallet_version)` no ledger. O teste `two writers racing without a lock` reproduz um lost update clássico sem `FOR UPDATE`, e o banco recusa o segundo;
- trigger de encadeamento: cada lançamento começa no `balance_after` do anterior;
- trigger *deferred*: no commit, saldo e versão da wallet precisam bater com o último lançamento.

Corridas entre wallets diferentes com a mesma chave (raro) estouram a unique de idempotência. O serviço repete a unidade de trabalho até 3 vezes, e na repetição a busca encontra a transação gravada e devolve replay.

## 7. Idempotência

- **Chave:** o header `Idempotency-Key` (HTTP) ou `data.idempotencyKey` (SQS) é a fonte da verdade, única por `(provider_id, idempotency_key)`. O `(provider_id, external_transaction_id)` também é único.
- **`payloadHash` = SHA-256 hex do JSON canônico** dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money{amount,currency}` e `referenceExternalTransactionId` (quando presente).
  - JSON canônico: chaves de objeto ordenadas recursivamente (ordem de code unit UTF-16), sem espaços, propriedades `undefined` omitidas, arrays na ordem original.
  - Header, `messageId`, `occurredAt` e qualquer metadado de transporte ficam de fora. Por isso a mesma transação tem o mesmo hash vinda por HTTP ou pela fila (teste `HTTP and SQS share the same use case`).
- **Mesma chave + mesmo hash** → resposta original com `idempotentReplay: true`, incluindo o **saldo observado naquele momento** (coluna `observed_balance`) e o mesmo status HTTP.
- **Mesma chave + hash diferente** → `409 IDEMPOTENCY_CONFLICT`. Nunca é replay.
- **Mesmo external id com outra chave** → `409 DUPLICATE_EXTERNAL_TRANSACTION`.
- **Nada em memória:** toda a deduplicação está no PostgreSQL.

**Inbox (SQS):** `inbox_messages (consumer_name, message_id)` é gravada na **mesma transação** do efeito financeiro. Uma redelivery encontra a linha e devolve replay. Se o mesmo `messageId` chegar com conteúdo diferente, vira `INBOX_PAYLOAD_CONFLICT` e vai para a DLQ.

## 8. Schema: garantias no banco

| Garantia | Como |
|---|---|
| 1 wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK` em `wallets.balance`, `balance_before`, `balance_after`, `observed_balance` |
| Idempotência | `UNIQUE (provider_id, idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| Reversão única | índice único parcial em `reference_transaction_id` para `REFUND/ROLLBACK` com status `PROCESSED` |
| ≤ 1 lançamento por transação/wallet | `UNIQUE (transaction_id, wallet_id)` |
| Sem lost update | `UNIQUE (wallet_id, wallet_version)` + trigger de encadeamento |
| Ledger imutável | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| Moeda do lançamento = moeda da wallet | FK composta `(wallet_id, currency) → wallets(id, currency)` |
| Referência na mesma wallet | FK composta `(reference_transaction_id, wallet_id) → wager_transactions(id, wallet_id)` |
| Saldo = último lançamento | constraint trigger `DEFERRABLE INITIALLY DEFERRED` em `wallets` e no ledger |
| `version` acompanha o saldo | trigger: muda o saldo ⇒ `version + 1`; não muda ⇒ `version` igual |
| Transação terminal congelada | trigger em `wager_transactions` |
| Coerência por status | `CHECK`s (ex.: `REJECTED/FAILED ⇔ failure_code`, `PENDING_REFERENCE ⇔ next_reference_attempt_at`) |

As migrations são versionadas e reversíveis: `bun run migrate` / `bun run migrate:down`. O teste `migrations are reversible` aplica up → down → up num banco descartável.

## 9. Regras de negócio e taxonomia de falhas

`failureCode` é contrato público (`src/domain/failure-code.ts`):

| Código | Situação | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | desistir ou tentar com outro valor |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK de WIN/REFUND deixaria saldo negativo | acionar operação (caso diferente de aposta sem saldo) |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | player não é o dono da wallet | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite | reenviar a referência e depois uma nova reversão |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/moeda/rodada | corrigir |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: REFUND de WIN, ROLLBACK de LOSS | corrigir |
| `REFERENCE_NOT_PROCESSED` | referência terminou REJECTED/FAILED | desistir |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência | corrigir |
| `ALREADY_REVERSED` | referência já revertida | nada: já foi revertida |
| `PROCESSING_FAILED` | reservado para `FAILED` | — |

Erros de **validação** (o payload nunca seria aceito) não viram transação e respondem `400` com código próprio: `INVALID_REQUEST`, `INVALID_MONEY`, `INVALID_AMOUNT`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED`, `INTERNAL_KIND_NOT_ALLOWED`.

### Interpretações adotadas

1. **Uma reversão por referência, qualquer que seja o tipo.** A regra 4 diz "não pode ser revertida duas vezes pelo mesmo tipo". Aceitar REFUND **e** ROLLBACK do mesmo BET creditaria o valor duas vezes, o que viola "não duplicar créditos". Reversões *rejeitadas* não contam.
2. **WIN e LOSS podem referenciar uma BET** (opcional). Se a referência vier, valem as mesmas validações e a espera por `PENDING_REFERENCE`.
3. **Valor zero:** só LOSS aceita `0.00`. Um WIN de zero é recusado (`INVALID_AMOUNT`); o provedor deve mandar LOSS. Isso evita lançamentos de valor zero, que o schema proíbe.
4. **A referência precisa estar PROCESSED.** Se ela ainda estiver `PENDING_REFERENCE` (ex.: ROLLBACK de um REFUND que espera o BET), a transação também espera.
5. **Wallet inexistente** é `404` e não é persistida: não há wallet onde registrar. Player diferente do dono é rejeição auditável (`WALLET_PLAYER_MISMATCH`).
6. **Limite de referência pendente:** 10 verificações com backoff exponencial de 1 s a 5 min (cerca de 17 min no total). Fica bem acima do atraso normal de redelivery (segundos) e ainda dentro de uma sessão de jogo. Esgotado o limite, a transação vira `REJECTED REFERENCE_NOT_FOUND` e o evento é publicado. É configurável (`REFERENCE_RETRY_*`).

## 10. API HTTP: status

O mesmo mapeamento vale em todos os endpoints (`exception.filter.ts` + `wagering.controller.ts`):

| Situação | Status | Reenviar? |
|---|---|---|
| Processada | `200` | — |
| Aceita, processamento pendente (`PENDING_REFERENCE`) | `202` | não precisa |
| Rejeição de negócio (corpo com `failureCode`) | `422` | não (mesma resposta) |
| Payload inválido | `400` | só corrigido |
| Recurso inexistente | `404` | — |
| Conflito (idempotência, duplicata, wallet existente) | `409` | não |
| Falha transitória (banco, lock) | `503` + `Retry-After` | **sim, é seguro** |
| Erro inesperado | `500` | — |

O replay devolve **o mesmo status** da primeira resposta, com `idempotentReplay: true`.

## 11. Mensageria

### Consumidor SQS (`WagerTransactionConsumer`)

- Long polling com lote de até 10 mensagens. Mensagens do mesmo `MessageGroupId` (a wallet) são processadas em ordem; grupos diferentes, em paralelo.
- Usa **o mesmo** `WagerTransactionService.submit` da API, com a inbox.
- **Ack (`DeleteMessage`) só depois do commit.**
- Classificação dos erros:
  - **negócio** (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`): ack;
  - **permanente** (mensagem inválida, conflito, wallet inexistente): copia para a DLQ com o atributo `failureReason` e depois apaga da fila principal;
  - **transitório/inesperado**: não dá ack. O `ChangeMessageVisibility` adia a mensagem com backoff `2^tentativa` s (máx. 60 s). Na entrega número `SQS_MAX_RECEIVE_COUNT` (5), ela vai para a DLQ como `RETRIES_EXHAUSTED:<código>`. A redrive policy da fila, com o mesmo limite, é a rede de segurança se o processo morrer em loop.
- **SIGTERM:** o Nest chama `beforeApplicationShutdown`; o loop aborta o long polling, termina as mensagens em andamento e devolve as não iniciadas (`VisibilityTimeout=0`). Verificado com `docker stop`: os três loops registram `"Stopped"`.

### Transactional outbox (`OutboxPublisher`)

- Transação, ledger, saldo, inbox e evento entram no **mesmo commit**. O evento só existe se a mudança existiu.
- Cada ciclo, numa transação:
  1. `SELECT … FOR UPDATE SKIP LOCKED` de um lote vencido;
  2. `SendMessageBatch` com `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`;
  3. marca `published_at`.

  Falhas parciais do lote ganham backoff (1 s a 60 s) e `last_error`.
- **Vários publishers:** o `SKIP LOCKED` divide o trabalho sem bloqueio nem evento repetido (teste com dois publishers, 65 eventos, cada um publicado uma vez).
- **Processo morre depois de enviar e antes do commit:** o lote volta a ficar pendente e outra instância reenvia. O SQS FIFO descarta a repetição pelo `MessageDeduplicationId` (janela de 5 min). Depois dessa janela, o consumidor deduplica pelo `eventId` (entrega at-least-once).
- Métricas `outbox_lag_seconds` (idade do evento pendente mais antigo) e `outbox_pending_messages`.

### Eventos

`IntegrationEvent<T>` é uma classe abstrata; `eventType` e `version` são definidos em cada subclasse. `data` carrega só `MoneyProps` (string decimal). O `aggregateId` é sempre a **wallet**, a unidade de consistência, o que dá ordem FIFO por wallet na fila de eventos.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive LOSS |
| `WagerTransactionRejected` | rejeição de negócio (inclusive `REFERENCE_NOT_FOUND`) |
| `WalletBalanceChanged` | somente quando há lançamento no ledger (inclusive OPENING) |
| `WagerTransactionPendingReference` | primeira vez que a referência não foi encontrada |

### Worker de referências pendentes

`PendingReferenceWorker` busca transações `PENDING_REFERENCE` com `next_reference_attempt_at <= now()` (índice parcial). Para cada uma, trava a wallet, relê a transação e roda o `WagerSettlement` de novo. Se duas instâncias pegarem a mesma transação, a segunda encontra o status mudado ou a próxima tentativa no futuro, e não faz nada.

## 12. Autenticação (não implementada, por decisão)

Autenticação não pontua, e o tempo foi para correção financeira e concorrência. O ponto de extensão é o `ProviderAuthGuard` (`src/interfaces/http/provider-auth.guard.ts`), aplicado aos controllers de wallet e de transação. Os endpoints de health e `/metrics` ficam abertos.

**Desenho previsto:**
1. Keycloak no `docker compose`, com um realm `wagering` e **um client confidencial por provedor** (fluxo *client credentials*).
2. O guard valida o JWT pelo JWKS do realm (`iss`, `aud`, `exp`; cache das chaves) e extrai o `azp` (client id) como `providerId` autenticado.
3. O guard recusa com `403` quando o `providerId` do corpo ou da rota difere do autenticado. Assim um provedor não envia nem consulta transações de outro.
4. Escopos por operação (ex.: `wallets:write` só para o backoffice).
5. A fila continua como canal interno confiável. O `providerId` da mensagem passa pelas mesmas validações de domínio.

## 13. Observabilidade

- **Logs JSON** (`src/observability/logger.ts`) com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. Valores monetários e payloads não são logados.
  - Exceções do driver trazem o SQL com os valores na mensagem; o logger corta o SQL e mantém só o motivo, e há teste para isso.
  - `X-Correlation-Id` é propagado ou gerado. No SQS, a correlação é o `messageId`.
- **Métricas Prometheus** em `GET /metrics`: transações por status/kind, duplicatas, conflitos de idempotência, retries por motivo, conflitos de lock, latência (histograma), mensagens por resultado, DLQ, eventos publicados/falhos, outbox lag e pendentes, divergências de reconciliação.
- **Health:**
  - `/health/live` não toca dependências, para o orquestrador não reiniciar a app quando o banco cai;
  - `/health/ready` testa o PostgreSQL e as três filas, com timeout de 2 s, e responde `503` quando algo está fora.
- **Reconciliação:** saldo gravado e saldo recalculado pelo ledger são lidos **na mesma instrução SQL** (mesmo snapshot). Uma divergência nunca é corrigida: é logada, contada e devolvida com `consistent: false` (teste corrompe a wallet contornando os triggers).

## 14. Testes

| Exigência | Onde |
|---|---|
| Money, Wallet, regras BET/WIN/LOSS/REFUND/ROLLBACK, moeda, payload divergente | `test/unit/*` |
| Migrations e constraints | `test/integration/schema.test.ts` |
| Atomicidade wallet/ledger/inbox/outbox | `wagering-api.test.ts` › atomicity (trigger força falha na outbox) |
| Inbox e redelivery | `messaging.test.ts` |
| Publishers concorrentes | `recovery.test.ts` › two publishers |
| Retry e DLQ | `messaging.test.ts` (falha transitória via trigger com SQLSTATE 40001) |
| 50 apostas iguais em paralelo | `concurrency.test.ts` |
| 2 × 80 sobre 100 | `concurrency.test.ts` |
| Wallets distintas em paralelo | `concurrency.test.ts` |
| ≥ 3 instâncias | `concurrency.test.ts` sobe 3 processos `bun src/main.ts` |
| Worker morto após commit e antes do ack | `recovery.test.ts` + `test/fixtures/crash-after-commit.ts` |
| Publisher morto após enviar e antes do commit | `recovery.test.ts` + `test/fixtures/crash-after-publish.ts` |
| REFUND/ROLLBACK antes da referência | `messaging.test.ts`, `wagering-api.test.ts` |
| Reinício com consistência final | `recovery.test.ts` › service restart (SIGKILL + nova instância) |

- Nada é mockado: PostgreSQL e LocalStack são reais. Cada arquivo de teste cria **um banco** e **filas exclusivas**, e apaga tudo no final.
- A invariante `wallet.balance == saldo reconstruído pelo ledger` é verificada direto no banco (`expectWalletConsistent`) ao final dos testes.

## 15. Trade-offs e limitações

- **Ordem dos eventos entre publishers concorrentes.** Com `SKIP LOCKED`, dois publishers podem enviar lotes da mesma wallet fora de ordem. Os eventos carregam `walletVersion`/`occurredAt` para o consumidor reordenar. Ordem estrita exigiria um publisher por partição (ex.: advisory lock por wallet).
- **O publisher segura a transação durante o envio ao SQS.** É simples e correto, mas ocupa uma conexão por publisher durante a chamada. Uma alternativa seria um lease (`locked_until`) com commit antes de enviar.
- **`FAILED` não é produzido hoje.** O status e o código existem no modelo e no schema, mas falhas permanentes de infraestrutura vão para a DLQ, onde a mensagem pode ser reprocessada via redrive depois de corrigida. Marcar a transação como `FAILED` a tornaria terminal e impediria esse reprocessamento.
- **Resolução da referência é por polling.** A primeira verificação acontece 1 s depois. Resolver na hora, na mesma transação em que a referência chega, é uma otimização possível.
- **Métricas são por instância** (o Prometheus agrega). Não há OpenTelemetry nem dashboard.
- **Inbox e outbox crescem sem limpeza.** Em produção, um job removeria linhas publicadas ou processadas depois de um período de retenção.
- **Autenticação** não implementada (seção 12).
- **Throughput por instância limitado pelo ORM:** cerca de 100–150 tx/s por processo neste ambiente. O PostgreSQL gasta cerca de 6 ms por aposta, e o resto é CPU do MikroORM na thread JS. O sistema escala horizontalmente; a investigação completa está no [LOAD_TEST.md](LOAD_TEST.md).
- **O consumidor SQS tem um loop de polling por instância** (até 10 mensagens em andamento), por isso consome abaixo do HTTP. Vários loops por instância seriam uma melhoria simples.
- **LocalStack fixado na 4.4**, porque as imagens mais novas exigem auth token.
