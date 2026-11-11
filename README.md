# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por HTTP e por SQS. Ele continua correto com mensagens duplicadas, fora de ordem, processadas em paralelo por várias instâncias, ou com o processo morrendo no meio.

O enunciado está em [CHALLENGE.md](CHALLENGE.md). As decisões, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md), e o teste de carga, com metodologia, resultados e análise do gargalo, em [LOAD_TEST.md](LOAD_TEST.md).

**Stack:** Bun 1.4 · TypeScript estrito · NestJS 11 · MikroORM 6 · PostgreSQL 17 · SQS (LocalStack) · Docker Compose.

## Subir o ambiente

Requisitos: Docker (engine Linux) e Bun 1.x.

```bash
cp .env.example .env
docker compose up --build -d --wait
```

O Compose sobe:

| Serviço | O que é |
|---|---|
| `postgres` | PostgreSQL 17 |
| `localstack` | SQS com `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 entregas) e `wagering-events.fifo` |
| `migrate` | aplica as migrations e termina |
| `app` | API em http://localhost:3000 + workers |
| `worker` × 2 | mesmas imagem e config, sem porta publicada: 3 instâncias no total |

Mais instâncias: `docker compose up -d --scale worker=4`. Para parar: `docker compose down` (mantém os dados) ou `docker compose down -v` (apaga os volumes).

## Rodar localmente (fora do container)

```bash
bun install
docker compose up -d --wait postgres localstack
bun run migrate
bun run dev
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run typecheck` | checagem de tipos (TypeScript estrito) |
| `bun run test:unit` | testes de unidade (domínio, Money, hash, eventos) |
| `bun run test:integration` | integração com PostgreSQL e LocalStack reais (precisa de `postgres` e `localstack` no ar) |
| `bun run test:concurrency` | só os testes de concorrência, múltiplas instâncias e crash |
| `bun run test` | tudo |
| `bun run test:load:compose` | teste de carga com o gerador dentro da rede do compose (precisa do ambiente completo no ar) |
| `bun run test:load` | o mesmo teste de carga, a partir do host |
| `bun run migrate` / `bun run migrate:down` | aplica / desfaz a última migration |

Os testes de integração criam **um banco e filas exclusivos por arquivo** e apagam tudo no final; não interferem no ambiente do Compose. Os de concorrência sobem **3 processos `bun src/main.ts`** de verdade.

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet; saldo inicial > 0 gera transação `OPENING` + `CREDIT` no ledger |
| `GET` | `/wallets/:walletId` | saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger, do mais recente para o mais antigo, com cursor opaco e estável |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo gravado × saldo recalculado pelo ledger |
| `POST` | `/wagering/transactions` | submete transação; header `Idempotency-Key` obrigatório |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET` | `/health/live` · `/health/ready` | liveness · readiness (PostgreSQL + filas) |
| `GET` | `/metrics` | métricas Prometheus |

Exemplo:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

**Status HTTP**

| Status | Significado |
|---|---|
| `200` | processada |
| `202` | aceita, aguardando referência |
| `422` | rejeitada por regra de negócio; o corpo traz `failureCode` |
| `400` | payload inválido |
| `404` | recurso inexistente |
| `409` | conflito (idempotência, duplicata, wallet existente) |
| `503` | falha transitória, com `Retry-After`; reenviar é seguro |

O replay devolve o mesmo status, com `idempotentReplay: true`. Detalhes e taxonomia de `failureCode` em [ARCHITECTURE.md](ARCHITECTURE.md#9-regras-de-negócio-e-taxonomia-de-falhas).

## Fila

Envie para `wager-transactions.fifo` uma mensagem `WagerTransactionRequested` (formato da seção 10 do enunciado), usando `MessageGroupId = walletId`. Os eventos de integração saem em `wagering-events.fifo`.

## Estrutura

```
src/
  domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry, WagerSettlement, eventos, inbox/outbox
  application/     casos de uso, portas, hash canônico, erros de aplicação
  infrastructure/  MikroORM (records, mappers, store, migrations), SQS, outbox publisher, workers
  interfaces/      HTTP (controllers, parsing, filtro de erros, guard) e consumidor SQS
  observability/   logger JSON e métricas
test/
  unit/            domínio puro
  integration/     schema, API, concorrência (3 processos), mensageria, crash e reinício
  fixtures/        processos que morrem no pior momento
```
