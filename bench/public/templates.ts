/**
 * Prompt templates for the public benchmark, one list per language and
 * format. A `{slot}` names a value from `dataset.ts`; everything else is
 * literal text. Templates are written as a user would paste them into an LLM
 * client: questions around code, logs, config files, e-mails, and stack traces.
 *
 * @module bench/public/templates
 */

import type { Language } from './values.ts'

/** Kinds of prompt the dataset covers. */
export type Format = 'chat' | 'code' | 'log' | 'config' | 'email' | 'stacktrace'

/** Every format, in report order. */
export const FORMATS: readonly Format[] = ['chat', 'code', 'log', 'config', 'email', 'stacktrace']

/** Templates per language and format; every list holds the same scenarios in that language. */
export const TEMPLATES: Readonly<Record<Language, Readonly<Record<Format, readonly string[]>>>> = {
  'en': {
    chat: [
      'Can you draft a polite reminder to {person} ({email}) about the invoice? Her phone is {phone} if a call is better. Reference order {order}.',
      'My SSN is {nationalId} and my card {card} was charged twice for order {order}. How do I dispute it?',
    ],
    code: [
      'Why does this fail?\n```python\nclient = Client(api_key="{secret}", host="{internalHost}")\ndef {identifier}(user):\n    return user.email  # e.g. {email}\n```\nWe are on version {version}.',
      'Refactor this test:\n```ts\nconst fixture = { owner: \'{person}\', contact: \'{email}\', id: \'{uuid}\' }\nconst root = \'{homePath}/src\'\n```',
    ],
    log: [
      'What does this mean?\n2026-10-05T09:12:44Z INFO login ok user={email} ip={privateIp} session={uuid}\n2026-10-05T09:12:45Z WARN retry ts={epoch} order={order}',
      'Deploy log:\ncommit {commit} built in 42s\nupload to {internalHost} as {homePath}/deploy failed: digest {sha256}',
    ],
    config: [
      'Is this config safe to commit?\n```yaml\ndatabase:\n  host: {privateIp}\n  password: {password}\nslack_token: {secret}\nrelease: {version}\n```',
      'Fix my .env:\nAPI_KEY={secret}\nADMIN_EMAIL={email}\nCACHE_HOST={internalHost}\nBUILD_ID={uuid}',
    ],
    email: [
      'Summarize this email:\n\nFrom: {person} <{email}>\nSubject: Shipment {tracking}\n\nHi, please call me at {phone}. Card ending used: {card}. Thanks!',
      'Translate to French:\n\nDear {person}, your request {order} was approved. Your SSN on file is {nationalId}.',
    ],
    stacktrace: [
      'Help me read this trace:\nTraceback (most recent call last):\n  File "{homePath}/app/main.py", line 88, in {identifier}\n    connect("{privateIp}", token="{secret}")\nConnectionError: refused (request {uuid})',
      'Node crashed:\nError: ENOENT: no such file\n    at Object.openSync ({homePath}/project/node_modules/fs.js:12:3)\n    at build ({version}) id={uuid}',
    ],
  },
  'zh-TW': {
    chat: [
      '幫我寫一封信給{person}（{email}），提醒他訂單 {order} 尚未付款，必要時打 {phone}。',
      '我的身分證字號是 {nationalId}，信用卡 {card} 被重複扣款，訂單編號 {order}，該怎麼申訴？',
    ],
    code: [
      '這段程式為什麼出錯？\n```python\nclient = Client(api_key="{secret}", host="{internalHost}")\ndef {identifier}(user):\n    return user.email  # 例如 {email}\n```\n版本 {version}。',
      '幫我重構這個測試：\n```ts\nconst fixture = { owner: \'{person}\', contact: \'{email}\', id: \'{uuid}\' }\nconst root = \'{homePath}/src\'\n```',
    ],
    log: [
      '這段日誌是什麼意思？\n2026-10-05T09:12:44Z INFO 登入成功 user={email} ip={privateIp} session={uuid}\n2026-10-05T09:12:45Z WARN 重試 ts={epoch} order={order}',
      '部署紀錄：\ncommit {commit} 建置 42 秒\n上傳到 {internalHost} 的 {homePath}/deploy 失敗：digest {sha256}',
    ],
    config: [
      '這份設定可以 commit 嗎？\n```yaml\ndatabase:\n  host: {privateIp}\n  password: {password}\nslack_token: {secret}\nrelease: {version}\n```',
      '幫我修 .env：\nAPI_KEY={secret}\nADMIN_EMAIL={email}\nCACHE_HOST={internalHost}\nBUILD_ID={uuid}',
    ],
    email: [
      '幫我摘要這封信：\n\n寄件者：{person} <{email}>\n主旨：包裹 {tracking}\n\n您好，請打 {phone} 聯絡我。使用的卡號：{card}。謝謝！',
      '翻成英文：\n\n{person}您好，您的申請 {order} 已核准。系統登記的身分證字號為 {nationalId}。',
    ],
    stacktrace: [
      '幫我看這個錯誤：\nTraceback (most recent call last):\n  File "{homePath}/app/main.py", line 88, in {identifier}\n    connect("{privateIp}", token="{secret}")\nConnectionError: refused (request {uuid})',
      'Node 當掉了：\nError: ENOENT: no such file\n    at Object.openSync ({homePath}/project/node_modules/fs.js:12:3)\n    at build ({version}) id={uuid}',
    ],
  },
  'zh-CN': {
    chat: [
      '帮我写一封邮件给{person}（{email}），提醒订单 {order} 还没付款，必要时打 {phone}。',
      '我的身份证号是 {nationalId}，银行卡 {card} 被重复扣款，订单号 {order}，怎么申诉？',
    ],
    code: [
      '这段代码为什么报错？\n```python\nclient = Client(api_key="{secret}", host="{internalHost}")\ndef {identifier}(user):\n    return user.email  # 例如 {email}\n```\n版本 {version}。',
      '帮我重构这个测试：\n```ts\nconst fixture = { owner: \'{person}\', contact: \'{email}\', id: \'{uuid}\' }\nconst root = \'{homePath}/src\'\n```',
    ],
    log: [
      '这段日志什么意思？\n2026-10-05T09:12:44Z INFO 登录成功 user={email} ip={privateIp} session={uuid}\n2026-10-05T09:12:45Z WARN 重试 ts={epoch} order={order}',
      '部署记录：\ncommit {commit} 构建 42 秒\n上传到 {internalHost} 的 {homePath}/deploy 失败：digest {sha256}',
    ],
    config: [
      '这份配置能提交吗？\n```yaml\ndatabase:\n  host: {privateIp}\n  password: {password}\nslack_token: {secret}\nrelease: {version}\n```',
      '帮我改 .env：\nAPI_KEY={secret}\nADMIN_EMAIL={email}\nCACHE_HOST={internalHost}\nBUILD_ID={uuid}',
    ],
    email: [
      '帮我总结这封邮件：\n\n发件人：{person} <{email}>\n主题：快递 {tracking}\n\n你好，请拨打 {phone} 联系我。所用卡号：{card}。谢谢！',
      '翻译成英文：\n\n{person}您好，您的申请 {order} 已通过。系统登记的身份证号为 {nationalId}。',
    ],
    stacktrace: [
      '帮我看这个报错：\nTraceback (most recent call last):\n  File "{homePath}/app/main.py", line 88, in {identifier}\n    connect("{privateIp}", token="{secret}")\nConnectionError: refused (request {uuid})',
      'Node 崩溃了：\nError: ENOENT: no such file\n    at Object.openSync ({homePath}/project/node_modules/fs.js:12:3)\n    at build ({version}) id={uuid}',
    ],
  },
  'ja': {
    chat: [
      '{person}さん（{email}）宛てに、注文 {order} の支払いリマインドを丁寧に書いてください。電話なら {phone} です。',
      '私のマイナンバーは {nationalId} です。カード {card} が二重に請求されました（注文番号 {order}）。どう対応すればいいですか？',
    ],
    code: [
      'このコードはなぜ失敗しますか？\n```python\nclient = Client(api_key="{secret}", host="{internalHost}")\ndef {identifier}(user):\n    return user.email  # 例: {email}\n```\nバージョン {version}。',
      'このテストをリファクタしてください：\n```ts\nconst fixture = { owner: \'{person}\', contact: \'{email}\', id: \'{uuid}\' }\nconst root = \'{homePath}/src\'\n```',
    ],
    log: [
      'このログの意味は？\n2026-10-05T09:12:44Z INFO ログイン成功 user={email} ip={privateIp} session={uuid}\n2026-10-05T09:12:45Z WARN 再試行 ts={epoch} order={order}',
      'デプロイログ：\ncommit {commit} ビルド 42 秒\n{internalHost} の {homePath}/deploy へのアップロード失敗：digest {sha256}',
    ],
    config: [
      'この設定はコミットしても安全ですか？\n```yaml\ndatabase:\n  host: {privateIp}\n  password: {password}\nslack_token: {secret}\nrelease: {version}\n```',
      '.env を直してください：\nAPI_KEY={secret}\nADMIN_EMAIL={email}\nCACHE_HOST={internalHost}\nBUILD_ID={uuid}',
    ],
    email: [
      'このメールを要約してください：\n\n差出人：{person} <{email}>\n件名：荷物 {tracking}\n\nお世話になっております。{phone} までお電話ください。使用したカード番号：{card}。',
      '英語に翻訳してください：\n\n{person}様、申請 {order} が承認されました。登録されているマイナンバーは {nationalId} です。',
    ],
    stacktrace: [
      'このエラーを読んでください：\nTraceback (most recent call last):\n  File "{homePath}/app/main.py", line 88, in {identifier}\n    connect("{privateIp}", token="{secret}")\nConnectionError: refused (request {uuid})',
      'Node がクラッシュしました：\nError: ENOENT: no such file\n    at Object.openSync ({homePath}/project/node_modules/fs.js:12:3)\n    at build ({version}) id={uuid}',
    ],
  },
}
