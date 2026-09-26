---
type: review
visibility: private
status: pending
date: 2026-09-26
author: "Codex (owner review draft)"
context: "Profile Pilot #16: owner-approved contract-design investigation"
---

# Profile の Skill 向け MCP 契約候補

## 判断対象

親リポジトリの合成 PoC は、ドメイン向けの一つの MCP tool が下位の record/media tool を呼べることを示した。ただし、その `append_profile_observation` は現行 Profile Skill の正式な1件登録契約ではない。ここでは現行 Skill と `creator-profile-datastore-read/v1`、`creator-profile-datastore-write/v1` から必要な操作を導き、**契約ドラフトの粒度**をレビューする。本番 Plugin、実データ、実資格情報、公開・インストール・cutover の選択ではない。

現行の責務を保つ。Skill は対象と観測の照合、業務計画、計画 hash・件数を含む実際の owner 承認、実行前再計画、業務完了と人への引継ぎを所有する。選択された datastore capability は、同一の actor・環境・リソース・操作・版に対する読取り、承認済み効果、各効果の証跡と結果不明時の照合を担う。公式 MCP と不足する media 実装の選択・認証・物理 ID は Skill に渡さない。

## 最小の操作候補

これは tool 名の採択ではなく、現在の capability の意味を MCP schema に表す際の入力・出力境界である。単一の巨大な Profile 業務 tool や汎用 Lark CRUD catalog を新設する提案ではない。

| 操作候補 | Skill から渡す意味 | 返す意味と停止条件 |
| --- | --- | --- |
| 対象・履歴を読む | 明示された環境、対象モードまたは creator ID 範囲 | 正規化された対象・履歴と、選択された actor/resource/version の照合可能な証跡。読取り失敗は空集合にしない |
| 書込みを準備する | 計画 hash、作成行、既存行への画像追記、各件数 | 選択と計画に束縛された prepared intent と件数。変更・曖昧さ・不一致は効果前停止 |
| 準備済み効果を適用する | prepared intent と、その**同じ計画・件数について実際に成立した承認**への参照 | upload → token を含む create、または正確な既存行への画像追記の効果証跡。completed／partial／unknown を区別し、盲目的に再送しない |
| 読取りで照合する | 元の計画と効果証跡 | 承認した全件の現在状態を再読し、完了・未解決と人が再開できる根拠を返す。読取り失敗は成功にしない |

`approval.reference` の文字列だけでは承認の証明にならない。現行経路は `authorize(review, approval)` と Provider の `authorizeIntent` を別に要求する。MCP 経路では、ホストまたは選択された composition が**具体的な actor・対象・計画・件数・効果に束縛された実際の承認**をどう検証するか、まだ証明できていない。単に MCP tool の引数に承認済みフラグや参照文字列を入れる実装は棄却する。この問題を解かずに write tool を本番候補にはしない。

media token は選択された書込み実装内で正確な create に使い、Skill 向けの自由に再利用できる戻り値にしない。結果不明の upload、create、既存行への追記は段階ごとに記録し、同じ選択の下で読取り照合する。並行 writer を許すか、許す場合の対策は選択された実行モデルの契約で決める。原子的な一意性や ACID を一律に要求しない。

## 同じ業務場面での照合

現行 `test/profile-plugin-pilot.test.mjs` と親 PoC は、ともに1 creator・followers=42・avatarあり・同じ観測時刻の**同じ業務場面**を使うが、識別子と画像 bytes は一致しない。したがって、これは同一バイト入力を2経路へ流した parity test ではなく、既存テストの結果と契約の比較である。

| 場面 | 現行 Profile fixture の観測 | 親 PoC の観測 | 差分 |
| --- | --- | --- | --- |
| 正常作成 | 計画・準備・合成承認・upload-before-create・全件 readback の後 `success` | 1件の upload-before-create・readback の後 `completed` | 計画、承認、全件照合が PoC にない |
| create 応答消失 | readback で回復し、create 1回、`recoveredFromAmbiguousResponse` | 1件 readback で回復し、逐次再呼出しも create 1回 | journal と計画単位の回復証跡が PoC にない |
| upload 失敗 | create 0回、`unresolved`、業務完了を主張しない | create 0回、`unknown` | media の効果判定と人への引継ぎが同値でない |
| 既存行の画像欠落 | 現行計画は別件数の attachment resume を扱う | 非対応 | 次の fixture が必要 |

次の合成比較では、同じ normalized observation と manifest を両候補へ与え、識別子・画像 hash・承認計画を一致させる。正常作成、create 応答消失、upload 結果不明、token 欠落、actor/resource/計画変更、既存行への画像追記、複数対象の部分効果、readback 障害について、計画 summary、効果順序、結果分類、再送回数と人への引継ぎを照合する。現行 fixture の合成承認は本物の owner 承認ではないため、承認の本人性を証明する test と扱わない。

## 判断と回復経路

推奨は、Skill の業務計画と承認を残し、現行の選択済み Profile datastore capability の意味を出発点に、上記の有界な MCP 操作をドラフト化して合成比較すること。正式な tool 名・引数・承認証跡・composition owner は、比較結果と選択されたホストの証拠を受けて別途確定する。現行 Runtime／Provider と `creator-profile-datastore-write/v1` は引き続き選択経路であり、移管・廃止・本番導入は別判断とする。

本ドラフトを取り消すには、この文書だけを戻す。合成比較は実サービスに書き込まない。資格ある担当者は現行 Skill 手順、計画と journal、Provider の読取り経路から安全な再開点を判断できる必要がある。候補 MCP の receipt がそれと同等かは未検証である。

## AI policy review

文書・Skill 知識方針、言語方針、開発方針および Private Source Integration Guide と照合した。owner review 用の未採択ドラフトとして、現行契約と合成 PoC の証拠、未証明の承認機構を分離した。実 resource ID、認証情報、実 creator データ、private の物理 field mapping は記載していない。source と test の対応、失敗時の停止・照合・人への引継ぎ、現行経路の rollback を記した。自己レビューは独立した受入判定ではない。
