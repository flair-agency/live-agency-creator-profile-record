---
type: review
visibility: private
status: pending
date: 2026-09-26
author: "Codex (owner review draft)"
context: "Profile Pilot #16: owner-approved contract-design investigation"
---

# Profile の Skill 向け MCP 境界の要求整理

## 判断対象

親リポジトリの合成 PoC は、ドメイン向けの一つの MCP tool が下位の record/media tool を呼べることを示した。ただし、その `append_profile_observation` は現行 Profile Skill の正式な1件登録契約ではない。ここでは業務上守るべき結果を先に整理し、現行 Skill と `creator-profile-datastore-read/v1`、`creator-profile-datastore-write/v1` の仕組みを、その結果を満たす**現行経路の契約と実装**として照合する。本番 Plugin、実データ、実資格情報、公開・インストール・cutover の選択ではない。

現行の責務を保つ。Skill は対象と観測の照合、owner に示す変更内容、必要な承認、業務完了と人への引継ぎを所有する。選択された datastore capability は、対象を限定した読取り・書込みと結果不明時の照合を担う。公式 MCP と不足する media 実装の選択・認証・物理 ID は Skill に渡さない。現行 Skill が規定する計画 hash、件数、再計画や Provider の確認は**現行経路では引き続き必須**である。将来の経路へ同じ機構を一般要件として移すかは、この草案では決めない。

## 業務要求、必要な保証、現行方式

| 業務上の要求 | 選択経路で確かめる性質 | 現行経路の方式。将来の必須方式とはしない |
| --- | --- | --- |
| owner 確認が必要な変更を、確認前に実行しない | 確認プロセスを caller が自己申告で迂回できず、確認した内容と実際の効果が食い違わない | 計画 hash・件数、`authorize`、`authorizeIntent`、実行前再計画 |
| 観測された profile 履歴を正しい対象に保存する | 選択された actor・環境・対象・操作が曖昧または変更されたら、効果前に停止する | Runtime selection、Provider prepare とフィールド再確認 |
| avatar を含む新規履歴を欠けた状態で作らない | 現行の upload-before-create 順序と、既存行への画像追記を区別する | media upload、token を含む create、attachment resume |
| 結果が不明な書込みをむやみに繰り返さない | 実際の状態を読んで完了・未解決を区別し、安全に再開できない場合は止める | journal、段階別 event、bounded readback、read-only verify |

この表は現行の明文化された契約を無効にしない。候補 MCP 経路が異なる承認・回復方式を使うなら、実行前に現行契約との差分を owner が審査し、必要な改訂を先に採択する。単なる tool schema や host の確認画面が、上表の保証を自動的に満たすとは扱わない。

## MCP 操作の粒度は未決

MCP は必要な操作の公開インターフェイスになり得るが、`prepare → apply → verify` という分割は現行経路から来ている。候補では、選択された対象・履歴の読取りと、承認が必要な profile 書込みおよび結果照合を表せることが先決である。たとえば host が実際の tool invocation に対して人の確認を求め、その確認内容と効果の一致を保てるなら、一つの有界な書込み tool も検討できる。できなければ、現行 Runtime の承認経路を保持する、準備と実行を分けるなどの方式を比較する。正式な tool 名・数・schema はこの比較から決める。

現行経路では `approval.reference` の文字列だけで承認は成立しない。候補経路でも、承認が必要な書込みを caller が `approved: true` のような自己申告だけで実行できる構造は棄却する。要求するのは**選択された実行経路で必要な人の確認を迂回できず、確認した変更と実行する効果が一致すること**であり、署名 token、永続的な承認台帳、現行 Runtime と同じ hash・callback 構造を先に要求しない。host confirmation が十分かどうかも、実際の host と操作内容で検証するまでは未証明である。

media token や物理フィールドを Skill 向けの自由に再利用できる入力・結果へ露出させない。結果不明の upload、create、既存行への追記は、選択された経路に適切な証拠で照合してから再開する。特定の journal 形式や段階別 event を一律に要求しない。並行 writer を許すか、許す場合の対策は選択された実行モデルの契約で決める。原子的な一意性や ACID を一律に要求しない。

## 同じ業務場面での照合

現行 `test/profile-plugin-pilot.test.mjs` と親 PoC は、ともに1 creator・followers=42・avatarあり・同じ観測時刻の**同じ業務場面**を使うが、識別子と画像 bytes は一致しない。したがって、これは同一バイト入力を2経路へ流した parity test ではなく、既存テストの結果と契約の比較である。

| 場面 | 現行 Profile fixture の観測 | 親 PoC の観測 | 差分 |
| --- | --- | --- | --- |
| 正常作成 | 計画・準備・合成承認・upload-before-create・全件 readback の後 `success` | 1件の upload-before-create・readback の後 `completed` | PoC は業務上の承認と全件完了を検証していない |
| create 応答消失 | readback で回復し、create 1回、`recoveredFromAmbiguousResponse` | 1件 readback で回復し、逐次再呼出しも create 1回 | 両者とも盲目的な再作成を避けるが、人が判断できる復旧情報の同等性は未検証 |
| upload 失敗 | create 0回、`unresolved`、業務完了を主張しない | create 0回、`unknown` | 両者とも create を止めるが、media の効果判定と人への引継ぎは未比較 |
| 既存行の画像欠落 | 現行計画は別件数の attachment resume を扱う | 非対応 | 次の fixture が必要 |

次の合成比較では、同じ normalized observation と manifest を両候補へ与え、識別子と画像 hash を一致させる。正常作成、create 応答消失、upload 結果不明、既存行への画像追記、対象・承認内容の変更、readback 障害について、**無断効果がないこと、意図した対象・値・画像、盲目的な再送がないこと、安全停止と人への引継ぎ**を照合する。現行 fixture の hash・件数・journal と候補経路の内部表現を同一にする試験ではない。現行 fixture の合成承認は本物の owner 承認ではないため、承認を迂回できないことの証明にもならない。

## 判断と回復経路

推奨は、業務要求と必要な保証を上の表で確認したうえで、現行の選択済み Profile datastore capability を比較対象に、最小の MCP 操作を合成入力で試すこと。正式な tool の粒度、承認方法、結果証拠と composition owner は、選択された host と比較結果を受けて決める。現行 Runtime／Provider と `creator-profile-datastore-write/v1` は引き続き選択経路であり、移管・廃止・本番導入は別判断とする。

本ドラフトを取り消すには、この文書だけを戻す。合成比較は実サービスに書き込まない。資格ある担当者は現行経路では Skill 手順、計画と journal、Provider の読取りから安全な再開点を判断できる。候補経路でも人が結果と安全な次の操作を判断できる必要があるが、証拠の形式を現行 journal や receipt と同じにする必要はない。

## AI policy review

文書・Skill 知識方針、言語方針、開発方針および Private Source Integration Guide と照合した。owner review 用の未採択ドラフトとして、業務要求、現行の実現方法、合成 PoC の証拠、未証明の host による承認を分けた。実 resource ID、認証情報、実 creator データ、private の物理 field mapping は記載していない。source と test の対応、失敗時の停止・照合・人への引継ぎ、現行経路の rollback を記した。自己レビューは独立した受入判定ではない。
