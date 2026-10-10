// The three local services the brain can lean on. All HTTP, no dependencies.

/** An OpenAI-compatible chat endpoint: Ollama (`ollama:<model>`, :11434) or Splash
 *  (`splash:<model>`, :8000, the Bonsai 27B server). Returns the parsed JSON object the
 *  model was told to produce. */
export async function llmJson(spec: string, system: string, user: string): Promise<any> {
  const [host, ...rest] = spec.split(":")
  const model = rest.join(":")
  const messages = [{ role: "system", content: system }, { role: "user", content: user }]
  if (host === "bedrock") return bedrockJson(spec, model, system, user)
  if (host === "ollama") {
    // Native API, not /v1: gemma4 and qwen3 are thinking models, and only here can thinking be
    // switched off. Left on, gemma4 spent 46s and its whole token budget reasoning about a
    // one-line request and returned empty content.
    const r = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, think: false, format: "json",
        keep_alive: "15m", options: { temperature: 0, num_predict: 400 } }),
    })
    if (!r.ok) throw new Error(`${spec}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
    return parseJson(spec, (await r.json()).message.content)
  }
  const base = "http://127.0.0.1:8000"
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 400, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  })
  if (!r.ok) throw new Error(`${spec}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  return parseJson(spec, (await r.json()).choices[0].message.content)
}

function parseJson(spec: string, text: string) {
  const m = (text ?? "").match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`${spec}: no JSON in ${String(text).slice(0, 120)}`)
  return JSON.parse(m[0])
}

const embCache = new Map<string, number[]>()

/** nomic-embed-text through Ollama, cached per string (task labels repeat across requests). */
export async function embed(texts: string[]): Promise<number[][]> {
  const missing = [...new Set(texts.filter(t => !embCache.has(t)))]
  for (let i = 0; i < missing.length; i += 64) {
    const chunk = missing.slice(i, i + 64)
    const r = await fetch("http://127.0.0.1:11434/api/embed", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", input: chunk }),
    })
    const { embeddings } = await r.json()
    chunk.forEach((t, k) => embCache.set(t, embeddings[k]))
  }
  return texts.map(t => embCache.get(t)!)
}

export const cosine = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / Math.sqrt(na * nb)
}

/** One System One choice through the sysone engine (/v1/systemone): -> {pick, probs}. */
export async function choose(state: string, question: string, options: string[]) {
  const criteria = Object.fromEntries(options.map((o, i) => [String(i), o]))
  const r = await fetch(process.env.ENGINE_URL ?? "http://localhost:8799/v1/systemone", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, questions: { q: { type: "choice", instructions: question, criteria } } }),
  })
  if (!r.ok) throw new Error(`engine HTTP ${r.status}`)
  const a = (await r.json()).answers.q
  const probs: number[] = options.map((o, i) => a.probabilities[`${i}: ${o}`] ?? a.probabilities[String(i)] ?? 0)
  return { pick: Number(a.choice), probs, backend: a.backend as string }
}

/** A frontier Claude model on Bedrock, as the ceiling test: raw invoke-model through the AWS CLI with
 *  a Messages-API body (credentials from the environment). Opus 5.5 rejects temperature and cannot
 *  switch thinking off, so only effort is set; thinking blocks come back empty and are skipped. */
async function bedrockJson(spec: string, model: string, system: string, user: string) {
  const { execFile } = await import("node:child_process")
  const { writeFileSync, readFileSync, mkdtempSync } = await import("node:fs")
  const dir = mkdtempSync("/tmp/bedrock-")
  writeFileSync(`${dir}/in.json`, JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 2000,
    system, messages: [{ role: "user", content: user }], output_config: { effort: "low" } }))
  await new Promise<void>((ok, bad) => execFile("aws", ["bedrock-runtime", "invoke-model", "--model-id", model,
    "--body", `fileb://${dir}/in.json`, `${dir}/out.json`], (e, _o, err) => e ? bad(new Error(`${spec}: ${err || e.message}`.slice(0, 300))) : ok()))
  const r = JSON.parse(readFileSync(`${dir}/out.json`, "utf8"))
  return parseJson(spec, (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""))
}

/** One turn of Ollama's native tool calling (thinking off): -> the assistant message, with tool_calls. */
export async function ollamaTools(model: string, messages: any[], tools: any[]) {
  const r = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools, stream: false, think: false, keep_alive: "15m",
      options: { temperature: 0, num_predict: 600 } }),
  })
  if (!r.ok) throw new Error(`ollama:${model}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  return (await r.json()).message
}
