# Agent2API

[English](README.md) | 日本語

認証済みのローカル AI Agent を、使い慣れた LLM API インターフェースとして公開します。

Agent2API は、ローカル Agent API のためのアプリケーションホストです。HTTP サーバーに [`llm-mimic-surface`](https://github.com/taiyop/llm-mimic-surface) をマウントし、プロトコルに依存しないリクエストを Agent2API コアに変換します。そのうえで Agent/モデルの対象を解決し、メッセージ履歴全体を決定的なプロンプトとして組み立て、実行を [`@headless-core/core`](https://github.com/taiyop/headless_core) に委譲します。

```text
OpenAI SDK
    │
    ▼
Agent2API
    │
    ▼
headless_core
    │
    ▼
認証済みのローカル Agent CLI
```

Agent2API が Agent にログインしたり、認証情報を読んだり、トークンを更新したり、プロバイダー API クライアントを実装したりすることはありません。使用する Codex、Claude Code、Grok、Agy、Devin、Mistral Vibe の CLI は、ユーザーがあらかじめインストールし、認証を済ませておく必要があります。

## アーキテクチャ

```text
OpenAI / Anthropic / Gemini / Custom API
                  │
                  ▼
          Agent2API HTTP Host
                  │
                  ▼
        LLMMimicSurface Plugin
                  │
                  ▼
      Agent2API Backend Adapter
                  │
                  ▼
      Canonical Agent IR + Runner
                  │
                  ▼
          Pluggable Agent Backend
                  │
                  ▼
         HeadlessCore Adapter
                  │
                  ▼
       Authenticated Agent CLI
```

依存の向きは意図的に次のようにしています。

```text
server ─────→ llm-mimic-surface
  │
  └────→ Agent2API Backend Adapter ─────→ core ←───── backends/*
```

- `core` は OpenAI、Fastify、headless_core のいずれにも依存しません。
- `llm-mimic-surface` は headless_core に依存しません。
- `backends/headless-core` は OpenAI に依存しません。
- Chat Completions と Responses は、同じ Canonical リクエストとバックエンドの経路を使います。

Fastify インスタンス、認証、ログ、設定、待ち受けアドレス、ライフサイクルは Agent2API が持ちます。LLMMimicSurface は外部プロトコルのルートを登録し、その HTTP/SSE のワイヤーフォーマットを担当します。

## 必要なもの

- Node.js 20 以上
- npm
- 対応する Agent CLI のうち 1 つ以上が、インストール済みかつ認証済みであること
- macOS または Linux。Windows では WSL2 の中で Agent2API を動かしてください（[Windows (WSL2)](#windows-wsl2) を参照）。
- Linux（WSL2 を含む）では、デフォルトで有効な[サンドボックス](#サンドボックス)のために `bwrap`、`socat`、`rg` が必要です:
  `sudo apt install bubblewrap socat ripgrep`

Agent2API に Agent プロバイダーの API キーは不要です。任意の HTTP アクセス認証を有効にしていなければ、OpenAI SDK クライアントにはダミーのキーを渡せば十分です。

## インストールと実行

パッケージは公開できる状態ですが、まだ npm レジストリには公開していません。ソースをチェックアウトして実行してください。

```bash
npm install
npm run build
node dist/cli/main.js serve --config ./examples/agent2api.config.json
```

`npm start` でも、ビルドしてからサンプル設定で起動できます。別の設定ファイルを使う場合は `npm run serve -- --config ./my.config.json` を使ってください。

開発中は、[Bun](https://bun.sh) がインストールされていれば `npm run dev` でビルドせずに TypeScript のソースから直接起動できます（型チェックは行われないので `npm run typecheck` を併用してください）。

公開後は、次のようにグローバルインストールできるようになります。

```bash
npm install -g agent2api
agent2api serve --config ./agent2api.config.json
```

デフォルトの待ち受けアドレスは `127.0.0.1:8080` です。このポートが使用中の場合は、設定ファイルの `server.port` を変えるか、設定より優先される `--port` を指定してください（`agent2api serve --config ./agent2api.config.json --port 8090`）。最小構成の設定は次のとおりです。

```json
{
  "backends": {
    "headless-core": {
      "cwd": ".",
      "timeoutMs": 120000
    }
  }
}
```

この設定では、Agent CLI はデフォルトで有効な[サンドボックス](#サンドボックス)の中で動きます。

`cwd`、タイムアウト、サンドボックス、モデルのルーティング、HTTP アクセスの設定は、サーバー側の設定でのみ指定できます。API リクエストのボディから作業ディレクトリ、環境変数、バイナリのパス、CLI 引数、シェルコマンドを選ぶことはできません。

## OpenAI 互換 API

実装済みのエンドポイント:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /health`
- `GET /docs`（Swagger UI）と `GET /openapi.json`

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "dummy",
  baseURL: "http://127.0.0.1:8080/v1"
});

const completion = await client.chat.completions.create({
  model: "codex/default",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" }
  ]
});

console.log(completion.choices[0]?.message.content);
```

Responses API:

```ts
const response = await client.responses.create({
  model: "codex/default",
  input: "Explain this repository in one sentence."
});
```

どちらのエンドポイントも、リクエストフィールド `stream: true` による SSE に対応しています（`streaming: true` は OpenAI 互換のフィールドではありません）。headless_core の進捗にはプロセスの状態や stdout、stderr が含まれることがあるため、アシスタントのテキストとして公開することはありません。現在の実装は、完了までバッファするストリーミングです。SSE 接続をすぐに開き、Agent の実行中はハートビートのコメントを送り、最後に返ってきた出力を 1 つのテキストデルタ、終了イベント、`[DONE]` の順に送ります。非ストリーミングのリクエストと比べて、最初のテキストが届くまでの時間は短くなりません。クライアントの切断は `AbortSignal` を通じて headless_core に伝わります。

ストリーミングのリクエストでは、HTTP `200 OK` は SSE 接続が確立したことを意味し、Agent の実行が成功したことは意味しません。その後に見つかったモデル解決や実行の失敗は、SSE のエラーイベントと、それに続く `[DONE]` として送られます。本当の逐次テキストストリーミングは、バックエンドが `output.delta` のような意味的に安全なアシスタント出力イベントを提供するようになれば追加できます。生の progress/stdout/stderr をアシスタントの出力として扱うことはありません。

## 会話の引き継ぎと Agent の常駐

Agent2API は Agent を起動したまま残し、会話もその中で開いたままにします。そのため、続きのターンでは Agent を起動し直さず、履歴全体も送り直しません。headless_core を通じて、Agent の永続的な接続方式（`codex app-server`、Claude Agent SDK、ACP（Grok、Devin、Mistral Vibe））を使います。Agy は既定では CLI のままです。Agy の ACP サーバーは自身の起動エラーを回答として返し、サンドボックスの中ではセッションを開けなかったため、`acp` は設定で選んだときだけ使います。手元のマシンでは、codex の続きのターンが `codex exec` の 6〜8 秒に対して約 2 秒でした。

**Chat Completions** では、クライアントの書き方は変わりません。いつもどおり `messages` に履歴全体を入れて送ります。最後の assistant メッセージまでの履歴が、Agent2API が開いたままにしている会話（モデルと effort が同じもの）と一致すれば、それより後のメッセージだけを Agent に渡します。一致しなければ、履歴全体で新しい会話を始めます。複数の会話を交互に続けてもかまいません。回答を再生成・編集したときや、モデルを変えたときは新しい会話になります。必ず新しい会話にするときは、次のヘッダーを付けます。

```
X-Agent2API-Conversation: new
```

**Responses API** では、`previous_response_id` で前の応答の続きにできます。`input` には新しい入力だけを入れます。

```ts
const first = await client.responses.create({ model: "codex/default", input: "KIWI という単語を覚えて。" });
const next = await client.responses.create({
  model: "codex/default",
  input: "覚えた単語は？",
  previous_response_id: first.id
});
```

古い応答から分岐したときや、その会話がすでに閉じているときは、その応答までの履歴で新しい会話を始めます。`store: false` を指定すると、会話も応答も残しません。応答はメモリに最新 1,000 件まで保持し、再起動すると消えます。

新しい会話も速くなります。Agent2API は、一度使った Agent ごとに未使用の会話を 1 つ用意しておくので（直前と同じモデルで開きます）、次のリクエストは Agent の起動を待ちません。

```json
{
  "sessions": { "enabled": true, "idleTimeoutSeconds": 600, "maxConversations": 8 },
  "backends": {
    "headless-core": {
      "transports": { "grok": "cli" },
      "prewarm": ["codex", "claude"]
    }
  }
}
```

- `sessions.enabled`（既定 `true`）: `false` にすると、これまでどおりリクエストごとに Agent CLI を実行します。その場合も `previous_response_id` は履歴を送り直す形で使えます。
- `sessions.idleTimeoutSeconds`（既定 600）: この時間使われなかった会話や、用意しておいた Agent を閉じます。何も使っていない Agent のプロセスは終了します。
- `sessions.maxConversations`（既定 8）: これを超えると、最も長く使われていない会話から閉じます。Claude Agent SDK では会話ごとに `claude` のプロセスが 1 つ動くので、大きくしすぎないでください。
- `backends.headless-core.transports`: `"cli"` にした Agent は CLI のままになります。ほかの値は `app-server`（codex）、`sdk`（claude）、`acp`（それ以外。Agy の既定は `cli`）です。
- `backends.headless-core.prewarm`: サーバーの起動時に立ち上げておく Agent です。最初のリクエストから起動を待たずに済みます。

Agent の永続的な接続方式を起動できないとき（任意の依存の `@anthropic-ai/claude-agent-sdk` が入っていない、など）は、警告をログに出し、その Agent は以後 5 分間 CLI で実行します。60 秒以内に会話を開けなかったときも同じです。開いたままの会話の Agent プロセスが終了していた場合は、履歴全体で会話を始め直します。サンドボックスは永続的な接続方式にもかかります。

Agent2API は codex を `--disable hooks` 付きで起動します。ユーザーの codex フック（`~/.codex/hooks.json`）は対話的に使うためのもので、`codex app-server` ではターンが終わらなくなることがあります。

## API ドキュメントと AI Agent 接続用の指示文

サーバーの起動中に `http://127.0.0.1:8080/docs` を開くと Swagger UI が表示されます。OpenAPI 3.1
のドキュメントは `/openapi.json` で取得できます。設定したマウントパス、モデル、エイリアス、Bearer
認証の有無が反映されます。Swagger UI のアセットは `swagger-ui-dist` からローカル配信するので、
オフラインでも動きます。

ページ上部には AI Agent 向けの接続用指示文（英語/日本語）と **Copy prompt** ボタンがあります。
Base URL、認証、モデル、タイムアウト、非対応機能がまとまっているので、Agent に貼り付ければこの
サーバーを呼び出せるようになります。Bearer 認証が有効でも、サーバーがトークンをページに埋め込む
ことはありません。ページの入力欄にトークンを入力すると、コピーする文面にだけ埋め込まれます（処理は
ブラウザ内で完結します）。

`/docs`、`/docs/assets/*`、`/openapi.json` は `/health` と同じく、Bearer 認証が有効でも公開されます。
無効にするには `"server": { "docs": false }` を設定してください。

## Bench: ブラウザで API を確認する

ソースのチェックアウトには、動いている Agent2API サーバーを確認するための小さな GUI が含まれています。Agent2API を起動してから、別のターミナルで次を実行します。

```bash
npm run bench -- --config ./examples/agent2api.config.json   # または: bun run bench -- --config ...
```

Bench は OS が選んだ空きポートで起動するので、ポートが競合することはありません。表示された URL を開いてください。ポートを固定したい場合は `--port <n>` を指定するか `BENCH_PORT` を設定します。固定したポートが使用中の場合はエラーになります。ブラウザはフォームの入力内容をポートごとに保存するため、ポートを固定すると前回の入力が次回も残ります。

Bench は設定ファイルから Agent2API のホスト、ポート、マウントパス、Bearer トークンを読み取ります。`--config` を指定しない場合は `http://127.0.0.1:8080` に接続します。`--target <url>` で接続先を上書きできます（Agent2API を `--port` で起動した場合に使います）。設定ファイルなしでトークンを渡すには `AGENT2API_TOKEN` を使います。

- **ステータスランプ**: 5 秒ごとに `GET /health` を確認します。
- **Models**: `/v1/models` のカタログです。クリックするとそのモデルを使います。
- **Request**: Chat Completions または Responses を、`stream: true` の有無、システムメッセージ、推論エフォートを指定して送ります。返答、HTTP ステータス、ヘッダーまでの時間、最初のテキストまでの時間、合計時間、keep-alive の回数、生の JSON または SSE イベントを表示します。Cancel で実行を中断でき、「Copy as curl」で同じリクエストをターミナル用にコピーできます。
- **Smoke test**: 1 つのプロンプトを複数のモデルに、並列または 1 つずつ送り、それぞれを pass、mismatch（返答に期待した文字列がない）、fail で表示します。

画面は Bench とだけ通信し、Bench が `/health`、`/v1/models`、`/v1/chat/completions`、`/v1/responses` を Agent2API に転送します。Bench は `127.0.0.1` でだけ待ち受け、自分の画面からのリクエストだけを受け付け、Bearer トークンを自分で付けるので、トークンがブラウザに渡ることはありません。

## モデルとエイリアス

Canonical なモデル ID は `<agent>/<model>` の形式です。

- `codex/default`
- `claude/default`、`claude/sonnet`、`claude/opus`、`claude/haiku`
- `grok/default`
- `agy/default`
- `mistral/default`

`GET /v1/models` には、headless_core のモデル設定ファイル `~/.config/headless-core/models.json`（`HEADLESS_CORE_MODELS_PATH` を設定した場合はそのパス）にあるモデル候補も `<agent>/<model>` の形で並びます。候補があるエージェントには `<agent>/default` も加わります。ファイルは `npx headless-core models init` で作れます。リクエストのたびに読み直すので、編集すれば再起動しなくても反映されます。ファイルがなければ何も足されず、壊れている場合は `/v1/models` がそのファイル名を含むエラーを返します。

一覧の先頭にはエイリアスが並び、その後にモデルがエージェントごとにまとまります。推論エフォートを受け付けるモデルには、`codex/gpt-6-luna/low` のようなエフォート付きの ID が続きます。モデル ID しか選べないクライアントでも、これでエフォートを選べます。エフォート付きの ID を出したくない場合は `"models": {"listEffortVariants": false}` を設定してください。一覧は目安です。一覧にない `<agent>/<model>[/<effort>]` も指定できます。

末尾に推論エフォートのサフィックスを付けることもできます。

```text
<agent>/<model>/<effort>
codex/gpt-5.6-luna/low
```

認識されるサフィックスの語彙は headless_core に由来し、`default`、`low`、`medium`、`high`、`xhigh`、`max` です。個々の Agent がすべての値に対応しているとは限らず、実際に受け付けるかどうかは選ばれたバックエンド/CLI に任されます。サフィックスが `default` の場合や、サフィックスを省略した場合、推論エフォートは指定されません。リクエストボディにも `reasoning.effort` が含まれている場合は、ボディで明示した値が優先されます。最後のパスセグメントにある、認識されるエフォートの語は予約語として扱われ、実行前にモデル名から取り除かれます。

Agy は Gemini などのモデルを、エフォートの段階を含むことがあるモデルスラッグで公開しています。スラッグ全体をモデル部分として使ってください。

```text
agy/gemini-3.7-flash-low    # 正しい: Agy のモデルスラッグ
agy/gemini-3.7-flash/low    # 拒否: Agy では汎用のエフォートサフィックスに対応していない
gemini/gemini-3.7-flash     # 拒否: `gemini` は HeadlessCore の Agent プロバイダーではない
```

これは認証済みの Agy CLI を通じた Gemini モデルの実行です。Gemini の外部プロトコルアダプターや、Gemini API への直接接続を追加するものではありません。

Mistral Vibe（`vibe` 3.1 以降）は `mistral` Agent です。モデル部分には Mistral API のモデル名ではなく、`~/.vibe/config.toml` にある Vibe のモデル**エイリアス**（自分で定義したものを含む）を指定します。`mistral/default` は Vibe のアクティブなモデルを使います。`vibe-acp` で実行します（sessions を無効にしたときは `vibe --agent ask --output streaming`）。どちらも Vibe の読み取り専用の `ask` エージェントで回答するので、承認待ちになることはありません。

推論エフォートは ACP のときだけ使えます。Vibe の `thinking` 設定（Off、Low、High、Max）に渡し、`none` は thinking を Off にします。使える段階はモデルによって違います。手元では、`mistral-medium-latest` は `none` と `high`、`zai-glm-5-3` は `low`・`high`・`max` を受け付けました。受け付けない段階を指定すると、使える段階を添えて拒否されます。Vibe CLI にはエフォートのオプションがないので、sessions を無効にしたときや `transports` で `"mistral": "cli"` にしたときは、エフォートサフィックスも `reasoning.effort` も拒否されます。ACP が起動できず一時的に CLI で動いている間は、エフォート付きのリクエストは `backend_unavailable` になり、あとで再試行できます。

```text
mistral/default        # Vibe のアクティブなモデル
mistral/devstral       # Vibe のモデルエイリアス
mistral/devstral/high  # ACP では thinking を High に、CLI では拒否
```

`model: "default"` は変更されずに headless_core に渡されるので、プロバイダーのモデルフラグなしで CLI 自身のデフォルトモデルが使われます。

モデルは OpenAI アダプターではなく `ModelRegistry` が解決します。`models.entries` を明示的に書くのは任意です。`codex/gpt-5.6-luna` のような未登録の Canonical ID は HeadlessCore バックエンドへ動的にルーティングされ、実際に使えるかどうかは headless_core/認証済みの CLI が判断します。`/v1/models` のレスポンスは、設定済み/デフォルトのエントリを見つけるためのカタログです。ローカルの CLI が受け付けるすべてのモデルを網羅した一覧ではありません。

エイリアスも任意で、動的な Canonical ID を直接指すこともできます。

```json
{
  "models": {
    "aliases": {
      "default": "codex/default",
      "smart": "claude/opus",
      "luna": "codex/gpt-5.6-luna",
      "luna-low": "codex/gpt-5.6-luna/low"
    }
  }
}
```

## 推論エフォート

OpenAI のリクエストフィールドは、まず Canonical IR にデコードされます。

```json
{
  "model": "codex/default",
  "reasoning": { "effort": "high" }
}
```

その後、HeadlessCore バックエンドが Canonical なエフォートを `headless.run()` に渡します。機能の検証により、推論に対応していないモデル/Agent での reasoning 指定は拒否されます。現在の HeadlessCore アダプターでは、Agy は汎用の `reasoning.effort` フィールドを受け付けません。代わりに `gemini-3.7-flash-low` のような Agy のモデルスラッグを選んでください。Mistral Vibe は ACP のときだけ推論エフォートを受け付けます。

## 任意の HTTP アクセス認証

これは `クライアント → Agent2API` の間を保護するもので、Agent CLI の認証とは関係ありません。

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8080,
    "auth": { "bearerToken": "local-secret" }
  }
}
```

この場合、クライアントは `Authorization: Bearer local-secret` を送ります。`/health` と [API ドキュメント](#api-ドキュメントと-ai-agent-接続用の指示文) は認証なしのままです。適切なホスト/ネットワークの制御と HTTP の Bearer トークンなしに、ループバック以外のインターフェースで待ち受けないでください。

## サンドボックス

Agent2API はデフォルトで、[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)（`srt`）による OS レベルのサンドボックスの中ですべての Agent CLI を動かします。macOS では Seatbelt（`sandbox-exec`）、Linux では bubblewrap を使うので、コンテナや VM は使いません。ネイティブの Windows には対応していないので、WSL2 を使ってください（[Windows (WSL2)](#windows-wsl2) を参照）。

サンドボックスなしで Agent CLI を動かすには、`sandbox` を `false` にします。この場合、Agent は現在のユーザーが読み書きできるものすべてを読み書きでき、どのホストにも接続できます。

```json
{
  "backends": {
    "headless-core": {
      "cwd": ".",
      "sandbox": false
    }
  }
}
```

起動時に、Agent2API はサンドボックスが動くかどうかを確認します。Linux（WSL2 を含む）では `bwrap`、`socat`、`rg` が必要です。たとえば `sudo apt install bubblewrap socat ripgrep` でインストールできます。確認に失敗した場合、Agent2API はサンドボックスなしで黙って動くのではなく、起動を拒否します。エラーメッセージには、直し方とサンドボックスを無効にする方法が示されます。続いて、Agent ごとに srt の設定ファイルとラッパースクリプトを 1 つずつ一時ディレクトリに書き出し、headless_core の `CODEX_BIN`、`CLAUDE_BIN`、`GROK_BIN`、`AGY_BIN`、`DEVIN_BIN`、`VIBE_BIN` をそれらのラッパーに向けます。このディレクトリはサーバーの終了時に削除されます。これらの変数をすでに設定している場合は、その値がサンドボックス内で実行する本来のバイナリとして使われます。

Agent は引き続き現在のユーザーとして動くので、既存のログインはそのまま使えます。macOS のキーチェーン（Claude Code）や認証情報ファイル（`~/.codex/auth.json`）も含みます。各 Agent は自分の状態ディレクトリに書き込めるので、トークンの更新も動作します。

Agent ごとのデフォルトのポリシー:

| | 許可するネットワーク | ホーム配下で読めるもの | 書き込み可能 | 備考 |
|---|---|---|---|---|
| `claude` | `anthropic.com`、`claude.ai`、`claude.com`（+ サブドメイン） | `cwd`、自分の状態、自分のバイナリ、`~/Library/Keychains`（macOS） | `~/.claude`、`~/.claude.json`（または `$CLAUDE_CONFIG_DIR`） | |
| `codex` | `openai.com`、`chatgpt.com`（+ サブドメイン） | `cwd`、自分の状態、自分のバイナリ | `~/.codex`（または `$CODEX_HOME`） | macOS での TLS 検証のため `enableWeakerNetworkIsolation` |
| `grok` | `x.ai`、`grok.com`（+ サブドメイン） | `cwd`、自分の状態、自分のバイナリ | `~/.grok` | |
| `agy` | `googleapis.com`（+ サブドメイン）、`accounts.google.com` | `cwd`、自分の状態、自分のバイナリ、`~/Library/Keychains`（macOS） | `~/.gemini`、`~/.antigravity`、`cwd` | `enableWeakerNetworkIsolation`。macOS では後述の `allowLocalBinding` のオプトインも必要 |
| `devin` | `devin.ai`、`codeium.com`、`windsurf.com`（+ サブドメイン） | `cwd`、自分の状態、自分のバイナリ | `~/.local/share/devin`、`~/.config/devin`（または `$XDG_DATA_HOME` / `$XDG_CONFIG_HOME` の下） | macOS の TLS 検証のための `enableWeakerNetworkIsolation` |
| `mistral` | `mistral.ai`、`mistral.services`（+ サブドメイン） | `cwd`、自分の状態、自分のバイナリ、`~/.agents`（共有スキル、読み取りのみ）、`~/Library/Keychains`（macOS） | `~/.vibe`（または `$VIBE_HOME`） | |

読み取りも書き込みも許可リスト方式なので、Agent はユーザー自身のファイルから隔離されます。

- **読み取り**: ホームディレクトリと `/Volumes`、`/mnt`（WSL2 での Windows のドライブ）、`/media` の下はすべて拒否し、表にあるパスだけを許可します。「自分の状態」はその Agent の書き込み可能なディレクトリです。「自分のバイナリ」は `PATH`（または `*_BIN`）で見つかった Agent CLI と、そこに至るまでのシンボリックリンク、スクリプトの場合はそのパッケージのディレクトリとインタプリタです（`uv tool` などの Python 仮想環境なら、その環境とベースの Python も含みます）。`/usr`、`/System`、`/etc`、`/opt/homebrew` などのシステムの場所は、CLI が起動できるよう読めるままにしています。macOS のキーチェーンのデータベースは、ログイン情報をそこに保存している Agent だけが読めます。中身は暗号化されたままで、キーチェーン自身のアクセス制御で守られます。
- **書き込み**: 表の書き込み可能なパスと、srt が Agent の `TMPDIR` に設定する `/tmp/claude` 以外はすべて拒否します。書き込み可能な `cwd` の中でも、srt は `.bashrc`、`.zshrc`、`.gitconfig`、`.git/hooks`、`.git/config`、`.mcp.json`、`.vscode/`、`.idea/` などシェルや git のファイルへの書き込みを禁止します。
- よくある秘密情報（`~/.ssh`、`~/.aws`、`~/.azure`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.netrc`、`~/.git-credentials`、`~/.npmrc`、`~/.config/gh`、`~/.config/gcloud`）と、ほかの Agent の状態ディレクトリも、名前を指定して拒否しています。

`cwd` の下はすべて読めるので、`cwd` がホームディレクトリそのものかその上のディレクトリの場合、Agent2API は起動を拒否します。`~/agent2api-work` のような専用のディレクトリを使ってください。

Agent CLI をバージョンマネージャーのシム（nodenv や asdf など）経由でインストールしている場合や、ホーム配下のほかのファイルが必要な場合は、権限エラーで失敗します。その Agent の `allowRead` にパスを追加してください。

ポリシーを調整するには、`sandbox` にオブジェクトを指定します（`"type": "srt"` は省略できます）。設定したリストはこれらのデフォルトに追加されます。トップレベルのリストはすべての Agent に、`agents.<id>` のリストはその Agent だけに適用されます。設定した真偽値はデフォルトを置き換えます。相対パスは設定ファイルのあるディレクトリを基準に解決されます。

```json
{
  "backends": {
    "headless-core": {
      "sandbox": {
        "filesystem": { "allowRead": ["~/datasets"] },
        "agents": {
          "codex": { "filesystem": { "allowRead": ["~/.anyenv"] } },
          "agy": {
            "network": { "allowedDomains": ["lh3.googleusercontent.com"] },
            "filesystem": { "allowWrite": ["./generated"] }
          }
        }
      }
    }
  }
}
```

`enableWeakerNetworkIsolation` は、サンドボックス内のプロセスが macOS の `com.apple.trustd.agent` にアクセスできるようにします。デフォルトでは、これを必要とする Agent でだけ有効になっています。

`allowLocalBinding` はすべての Agent で無効です。Agy は内蔵の言語サーバーのために、ランダムな `127.0.0.1` のポートで待ち受けます。

- **Linux**: srt はこのフラグを無視します。サンドボックスは独自のループバックインターフェースを持つので、Agy は動作し、ホストのローカルサービスにはアクセスできません。
- **macOS**: Seatbelt では、これらのポートでの待ち受けを許可すると、Agent2API 自身やローカルのデータベース、開発サーバーを含む、すべての localhost ポートへの接続も許可することになります。オプトインしない場合、Agy へのリクエストは、この設定名を示す `backend_unavailable` エラーで失敗します。このトレードオフを受け入れる場合は次のように設定します。

```json
{
  "backends": {
    "headless-core": {
      "sandbox": {
        "agents": { "agy": { "network": { "allowLocalBinding": true } } }
      }
    }
  }
}
```

オプトインする場合は、サンドボックス内の Agent がトークンなしで Agent2API を呼び出せないよう、`server.auth.bearerToken` も設定してください。

### Windows (WSL2)

Windows では、サンドボックスを使うかどうかにかかわらず、Agent2API と Agent CLI を WSL2 の Linux ディストリビューションの中で動かしてください。bubblewrap には本物の Linux カーネルが必要なので、WSL1 では動きません。WSL2 の中では Linux 版のサンドボックスが使われるので、コードを変更せずに動作し、Agy も `allowLocalBinding` なしで動きます。WSL2 は Windows に付属しているので、Docker Desktop や別の VM は不要です。

1. WSL2 と Ubuntu などのディストリビューションをインストールします: `wsl --install`
2. ディストリビューションの中で、サンドボックスの依存パッケージをインストールします: `sudo apt install bubblewrap socat ripgrep`
3. ディストリビューションの中で、Node.js 20 以上と使いたい Agent CLI をインストールし、それぞれにそこでログインします。Windows 側のログインは WSL と共有されません。
4. ディストリビューションの中で `agent2api serve` を実行します。サンドボックスはデフォルトで有効です。

WSL2 のデフォルトの localhost 転送により、Windows のアプリケーションからは `http://localhost:8080` でサーバーにアクセスできます。アクセスできない場合は、ミラーモードのネットワーク（`%UserProfile%\.wslconfig` に `networkingMode=mirrored`）を有効にしてください。プロジェクトと Agent の `cwd` は、速度のためと、サンドボックスがファイルアクセスを制御できるようにするため、`/mnt/c` の下ではなく Linux のファイルシステム上（たとえば `~/work`）に置いてください。

ネイティブの Windows には対応していません。srt の Windows バックエンド（アルファ版）は、コマンドを別の `srt-sandbox` ユーザーとして実行します。このユーザーは独自のプロファイルを持ち、呼び出し元ユーザーの認証情報ストアを読めず、Windows の TLS スタック（Schannel）も使えません。これは、Agent CLI の既存のログインを再利用するという Agent2API の前提と相容れません。また、管理者権限でのインストール手順も必要です。ネイティブの Windows では、Agent2API は起動を拒否し、WSL2 を案内します。`sandbox` を `false` にするとこの確認は行われませんが、ネイティブの Windows でサンドボックスなしに Agent CLI を動かすことも検証していません。

WSL2 での構成はまだ検証していません。問題があればお知らせください。

## ログ

リクエストは、リクエスト ID、プロトコル、解決されたモデル、バックエンド、Agent、所要時間、ステータスを含む構造化レコードとして記録されます。プロンプトのテキスト、Agent の出力、認証情報、環境変数は、デフォルトでは記録しません。無視された互換パラメーターは、値ではなくパラメーター名だけが記録されます。

## MVP で未対応のもの

Agent2API は、未対応の入力を黙って捨てるのではなく、明示的に `unsupported_feature` を返します。

- OpenAI の外部ツール、`tool_calls`、並列ツール呼び出し
- 画像、音声、ファイルの入力
- エンベディング、画像生成、音声生成
- リモート MCP

Agent CLI が内部で独自のツールを使うことはあります。ただし、それによって API クライアントに OpenAI のツール呼び出しが公開されるわけではありません。

`temperature`、`top_p`、クライアント固有の拡張など、上記の明示的な機能を選択しない未知の互換パラメーターは、互換性がある範囲で外部プロトコル層が受け付けますが、実行の制御として headless_core に渡されることはありません。明示的なツール、未対応のメディア、ファイルは引き続き拒否されます。

## 責任の境界

`headless_core`:

- ローカルの AI Agent CLI を実行する
- プロバイダー固有の CLI 引数を持つ
- タイムアウトと中断のプロセス処理を持つ
- 推論エフォートを対応づける
- モデルの候補を扱う
- 実行の失敗を分類する

`llm-mimic-surface`:

- Agent2API の Fastify ホストに OpenAI 互換のルートを登録する
- 外部リクエストを、プロトコルに依存しない境界の契約に解析する
- HTTP レスポンス、API エラー、SSE イベントをシリアライズする
- クライアントの切断を `AbortSignal` を通じて伝える

Agent2API:

- HTTP サーバー、認証、ログ、設定、ライフサイクルを持つ
- そのサーバーに LLMMimicSurface を登録する
- Canonical Agent IR とイベントを定義する
- 設定されたモデルとエイリアスを解決する
- メッセージ履歴をプロンプトに変換し、リクエストをまたいで会話を開いたままにする
- レスポンスとストリーミングイベントを変換する
- API レベルのエラーを正規化する

Agent2API は、Agent CLI の認証/OAuth、認証情報の保存やローテーション、AI プロバイダー API の直接呼び出し、課金、データベース、Web UI、Agent のロジック、CLI プロセスの起動を実装しません。サンドボックスは headless_core が起動するバイナリを包むだけで、Agent を自分で起動することはありません。

## 開発

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

通常のテストスイートは `FakeAgentBackend` を使うので、CI に Codex、Claude Code、Grok、Agy、Devin、Mistral Vibe は必要ありません。実際の Agent を使う E2E テストを追加する場合は、`AGENT2API_E2E=1` によるオプトインにしてください。

## ライセンス

MIT
