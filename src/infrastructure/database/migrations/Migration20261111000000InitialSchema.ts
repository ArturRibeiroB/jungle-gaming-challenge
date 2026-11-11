import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As invariantes financeiras ficam no banco, não só no código:
 *
 * - unicidade: uma wallet por (player, moeda); idempotência por (provider, key) e (provider, external id);
 *   uma reversão processada por referência; um lançamento por (transação, wallet); versão única por wallet.
 * - não-negatividade: CHECK em saldo e em todos os saldos do ledger.
 * - imutabilidade: o ledger é append-only (trigger bloqueia UPDATE/DELETE/TRUNCATE) e os campos de negócio
 *   de uma transação não mudam; transação terminal não muda mais de status.
 * - consistência: no commit, saldo e versão da wallet precisam bater com o último lançamento do ledger.
 *
 * As FKs são DEFERRABLE INITIALLY DEFERRED: são checadas no commit, então a ordem dos INSERTs
 * dentro da transação (decidida pelo Unit of Work do ORM) não importa.
 */
export class Migration20261111000000InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid not null,
        currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) not null check (balance >= 0),
        version     integer not null check (version >= 1),
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint uq_wallets_player_currency unique (player_id, currency),
        -- alvo da FK composta do ledger: garante que o lançamento usa a moeda da wallet
        constraint uq_wallets_id_currency unique (id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        varchar(100) not null check (provider_id <> ''),
        external_transaction_id            varchar(200) not null check (external_transaction_id <> ''),
        idempotency_key                    varchar(300) not null check (idempotency_key <> ''),
        payload_hash                       char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                          uuid not null references wallets (id) deferrable initially deferred,
        player_id                          uuid not null,
        round_id                           varchar(200),
        game_id                            varchar(200),
        kind                               varchar(16) not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(20, 2) not null check (amount >= 0),
        currency                           char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  varchar(200),
        reference_transaction_id           uuid,
        status                             varchar(24) not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       varchar(64),
        observed_balance                   numeric(20, 2),
        reference_attempts                 integer not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at          timestamptz,
        created_at                         timestamptz not null,
        processed_at                       timestamptz,
        updated_at                         timestamptz not null,

        constraint uq_wager_tx_external unique (provider_id, external_transaction_id),
        constraint uq_wager_tx_idempotency unique (provider_id, idempotency_key),
        -- alvo das FKs compostas (referência e ledger precisam ser da mesma wallet)
        constraint uq_wager_tx_id_wallet unique (id, wallet_id),
        constraint fk_wager_tx_reference_same_wallet
          foreign key (reference_transaction_id, wallet_id) references wager_transactions (id, wallet_id) deferrable initially deferred,

        constraint ck_wager_tx_round_game
          check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        constraint ck_wager_tx_amount_positive
          check (kind = 'LOSS' or amount > 0),
        constraint ck_wager_tx_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_wager_tx_reference_allowed
          check (kind not in ('OPENING', 'BET') or reference_external_transaction_id is null),
        constraint ck_wager_tx_reference_resolved
          check (reference_transaction_id is null or reference_external_transaction_id is not null),
        constraint ck_wager_tx_reversal_resolved
          check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null),
        constraint ck_wager_tx_failure_code
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint ck_wager_tx_processed_at
          check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint ck_wager_tx_observed_balance
          check ((status in ('PROCESSED', 'REJECTED')) = (observed_balance is not null)),
        constraint ck_wager_tx_observed_balance_non_negative
          check (observed_balance is null or observed_balance >= 0),
        constraint ck_wager_tx_pending_reference_schedule
          check ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null))
      );
    `);

    // Uma referência só pode ser revertida uma vez, seja por REFUND ou por ROLLBACK.
    // Reversões rejeitadas não contam, por isso o índice é parcial.
    this.addSql(`
      create unique index uq_wager_tx_single_reversal
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);
    // Fila do worker de referências pendentes.
    this.addSql(`
      create index ix_wager_tx_pending_reference_due
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    // Quando uma referência chega, encontra rápido quem estava esperando por ela.
    this.addSql(`
      create index ix_wager_tx_waiting_for_reference
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        wallet_id       uuid not null,
        transaction_id  uuid not null,
        direction       varchar(6) not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) not null check (amount > 0),
        currency        char(3) not null,
        balance_before  numeric(20, 2) not null check (balance_before >= 0),
        balance_after   numeric(20, 2) not null check (balance_after >= 0),
        wallet_version  integer not null check (wallet_version >= 1),
        created_at      timestamptz not null,

        constraint fk_ledger_wallet_currency
          foreign key (wallet_id, currency) references wallets (id, currency) deferrable initially deferred,
        constraint fk_ledger_transaction_same_wallet
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id) deferrable initially deferred,
        -- no máximo um lançamento por transação em cada wallet
        constraint uq_ledger_transaction_wallet unique (transaction_id, wallet_id),
        -- cadeia de versões: dois escritores concorrentes nunca gravam a mesma versão
        constraint uq_ledger_wallet_version unique (wallet_id, wallet_version),
        constraint ck_ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name  varchar(100) not null,
        message_id     varchar(200) not null,
        payload_hash   char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at    timestamptz not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     uuid not null,
        event_type       varchar(100) not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz not null,
        published_at     timestamptz,
        last_error       varchar(1000)
      );
    `);
    this.addSql(`
      create index ix_outbox_pending_due
        on outbox_messages (next_attempt_at)
        where published_at is null;
    `);

    // ---- Ledger append-only
    this.addSql(`
      create function forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger trg_ledger_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_mutation();
    `);
    this.addSql(`
      create trigger trg_ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_mutation();
    `);

    // ---- Encadeamento: cada lançamento começa onde o anterior terminou
    this.addSql(`
      create function check_ledger_chain() returns trigger language plpgsql as $$
      declare
        previous record;
      begin
        select balance_after, wallet_version into previous
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by wallet_version desc
         limit 1;

        if not found then
          if new.balance_before <> 0 then
            raise exception 'first ledger entry of wallet % must start at 0, got %', new.wallet_id, new.balance_before
              using errcode = 'check_violation';
          end if;
        elsif new.wallet_version <> previous.wallet_version + 1 or new.balance_before <> previous.balance_after then
          raise exception 'ledger entry for wallet % breaks the chain: expected version % from balance %, got version % from balance %',
            new.wallet_id, previous.wallet_version + 1, previous.balance_after, new.wallet_version, new.balance_before
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger trg_ledger_chain
        before insert on wallet_ledger_entries
        for each row execute function check_ledger_chain();
    `);

    // ---- Wallet: identidade imutável e version acompanha o saldo
    this.addSql(`
      create function guard_wallet_update() returns trigger language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'wallet % identity columns are immutable', old.id using errcode = 'restrict_violation';
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallet % version must increase by exactly 1 when the balance changes', old.id
            using errcode = 'check_violation';
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet % version can only change together with the balance', old.id
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger trg_wallet_guard
        before update on wallets
        for each row execute function guard_wallet_update();
    `);
    this.addSql(`
      create trigger trg_wallet_no_delete
        before delete on wallets
        for each row execute function forbid_mutation();
    `);

    // ---- Consistência saldo x ledger, verificada no COMMIT (deferred)
    this.addSql(`
      create function assert_wallet_matches_ledger(target_wallet uuid) returns void language plpgsql as $$
      declare
        wallet_row record;
        last_entry record;
      begin
        -- relê o estado atual: a wallet pode ter mudado várias vezes na mesma transação
        select balance, version into wallet_row from wallets where id = target_wallet;
        if not found then
          raise exception 'ledger references missing wallet %', target_wallet using errcode = 'foreign_key_violation';
        end if;

        select balance_after, wallet_version into last_entry
          from wallet_ledger_entries
         where wallet_id = target_wallet
         order by wallet_version desc
         limit 1;

        if not found then
          if wallet_row.balance <> 0 or wallet_row.version <> 1 then
            raise exception 'wallet % has balance % (version %) but no ledger entries',
              target_wallet, wallet_row.balance, wallet_row.version using errcode = 'check_violation';
          end if;
        elsif last_entry.balance_after <> wallet_row.balance or last_entry.wallet_version <> wallet_row.version then
          raise exception 'wallet % is out of sync with its ledger: wallet has % (version %), ledger has % (version %)',
            target_wallet, wallet_row.balance, wallet_row.version, last_entry.balance_after, last_entry.wallet_version
            using errcode = 'check_violation';
        end if;
      end;
      $$;
    `);
    this.addSql(`
      create function check_wallet_matches_ledger() returns trigger language plpgsql as $$
      begin
        perform assert_wallet_matches_ledger(new.id);
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create function check_ledger_matches_wallet() returns trigger language plpgsql as $$
      begin
        perform assert_wallet_matches_ledger(new.wallet_id);
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger trg_wallet_matches_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function check_wallet_matches_ledger();
    `);
    this.addSql(`
      create constraint trigger trg_ledger_matches_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function check_ledger_matches_wallet();
    `);

    // ---- Transação: campos de negócio imutáveis e status terminal congelado
    this.addSql(`
      create function guard_wager_transaction_update() returns trigger language plpgsql as $$
      begin
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % business fields are immutable', old.id using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%) and cannot change', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger trg_wager_tx_guard
        before update on wager_transactions
        for each row execute function guard_wager_transaction_update();
    `);
    this.addSql(`
      create trigger trg_wager_tx_no_delete
        before delete on wager_transactions
        for each row execute function forbid_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop table if exists wallets;');
    this.addSql('drop function if exists guard_wager_transaction_update();');
    this.addSql('drop function if exists check_ledger_matches_wallet();');
    this.addSql('drop function if exists check_wallet_matches_ledger();');
    this.addSql('drop function if exists assert_wallet_matches_ledger(uuid);');
    this.addSql('drop function if exists guard_wallet_update();');
    this.addSql('drop function if exists check_ledger_chain();');
    this.addSql('drop function if exists forbid_mutation();');
  }
}
