# 採用ガイド: PostgreSQL の監査ログを透明性ログにする(`human-cord/transparency`)

> 目的: 「事後に誰も(運用者を含め)監査ログを書き換え・削除できなかった」ことを、
> 署名済み Merkle チェックポイントと公開鍵だけで、運用者を信用せずに第三者が確かめられるようにする。
> 線形ハッシュチェーンは採らない(葉は互いに独立=同時書き込みで競合しない。失敗は欠損であって連鎖破裂ではない)。

## 1. 表に 2 列足す

既存の監査ログ表(例: `audit_logs`)に、全順序と葉ハッシュを追加する。既存の INSERT 経路は無改変でよい。

```sql
alter table audit_logs add column if not exists seq bigint generated always as identity;
alter table audit_logs add column if not exists leaf_hash bytea;
create unique index if not exists audit_logs_seq_idx on audit_logs (seq);
```

## 2. 行を正準直列化して葉ハッシュを自動計算する

`jsonb_build_object(...)::text` を通すとキー順・エスケープが固定され、区切り文字インジェクションが消える。
バージョンタグ `v` を入れておく(将来の書式変更に備える)。BEFORE INSERT トリガで `leaf_hash = sha256(canonical)`。

```sql
create or replace function audit_logs_canonical(r audit_logs) returns text language sql stable as $$
  select jsonb_build_object('v', 1, 'seq', r.seq, 'id', r.id::text, 'actor', coalesce(r.user_id::text, ''),
                            'action', r.action, 'details', r.details,
                            'at', to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
$$;
-- トリガ本体は各社の関数命名規約に合わせて書く: new.leaf_hash := digest(audit_logs_canonical(new), 'sha256');
```

`leaf_hash` の値(32 byte)が `human-cord/transparency` の **葉エントリ**(`merkleRoot(entries)` の要素)になる。
ライブラリ側でさらに `0x00` プレフィックス付きハッシュを取る(RFC 6962 の葉ドメイン分離)ので、二重ハッシュになるが問題ない。

## 3. 追記専用を DB 側でも強制する

UPDATE / DELETE / TRUNCATE を拒否するトリガを付ける。**DB 所有者はトリガを外せる**ので、これは最終防壁ではない。
最終防壁は §4 の署名済みチェックポイントと、その外部複製である。

## 4. チェックポイントを署名して残す

```js
import { signCheckpoint, verifyCheckpoint, inclusionProof, verifyInclusion } from 'human-cord/transparency';

const entries = rows.map((r) => r.leaf_hash);            // seq 順の全葉
const prev = await latestCheckpoint();                    // {tree_size, root, hash} or null
const c = signCheckpoint(entries, process.env.ISSUER_PRIVATE_KEY_PEM, { prev, origin: 'audit_logs' });
if (!c.ok) alarm(c.alarm, c.detail);                      // 縮小・書き換えは黙らせない
else await insertCheckpoint({ ...c.checkpoint, attestation: c.attestation });
```

- チェックポイント表も追記専用にする。`prev` で連鎖するが低頻度・単一書き手なので競合しない。
- `attestation` は attestation profile v1(JWS)。**公開鍵だけで** `verifyCheckpoint()` できる。
- 日次(業務終了後)に 1 回、加えて重要な発行(証明書など)のたびに 1 回。

## 5. 外部に複製する(ここが要)

署名済みチェックポイント `{tree_size, root, prev, attestation}` を運用者の手が届かない場所へ出す。

- 顧客に渡す文書の facts に `anchor: {tree_size, root}` を同梱する(配布物 1 枚 1 枚がログ状態の証人になる)
- 公開 Git リポジトリへ日次でコミットする
- 将来: RFC 3161 タイムスタンプ、公開透明性ログへの提出

## 6. 監査人の検証手順(運用者を信用しない)

1. JWKS(発行者公開鍵)を帯域外(契約書・公式サイト)で入手する。
2. チェックポイントの `attestation` を `npx human-cord verify` または Python 参照実装で検証する。
3. 全行の `leaf_hash` を seq 順に取り出し、`verifyCheckpoint(attestation, jwks, { entries })` で
   「チェックポイントは現在の木の接頭辞か」を確かめる(過去の書き換え・削除はここで露見する)。
4. 特定の行については `inclusionProof` / `verifyInclusion` で「その行がその時点で存在した」を示す。
5. 2 つのチェックポイント間は `consistencyProof` / `verifyConsistency` で「追記しかされていない」を示す。

## 7. 正直な限界

- 最初のチェックポイント前に消された行は検出できない(重要イベントごとのチェックポイントで窓を最小化する)。
- DB 所有者はトリガを外せる。署名済みチェックポイントの外部複製が最終防壁。
- 時刻は DB 時計を信用する。厳密な時刻証明は別の仕組み(RFC 3161 等)。
- `merkleRoot` は全葉を読む O(n log n)。数十万行を超えたら、葉ハッシュのキャッシュか compact range を検討する。
