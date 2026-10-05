// TRACES OF THE PLAN CHAT, INTO A LOCAL PHOENIX. OpenTelemetry spans named the OpenInference way (what
// Phoenix reads): one AGENT span per reply, an LLM span per model call, a TOOL span per tool call.
//
// LOADED ONLY WHEN PHOENIX ANSWERS. agent.ts imports this lazily after `/phoenix/healthz` responds, so a
// page with no Phoenix behind it never downloads the OpenTelemetry code and nothing can fail. `/phoenix`
// is a same-origin path the Vite server forwards to the timeline-studio-phoenix container (vite.config.ts):
// Phoenix answers a browser's CORS preflight with 405, and only accepts OTLP as protobuf.
import { context, trace, type Span, type Context } from "@opentelemetry/api";
import { WebTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions";

const provider = new WebTracerProvider({
  resource: resourceFromAttributes({ [SEMRESATTRS_PROJECT_NAME]: "timeline-studio-chat", "service.name": "timeline-studio-chat" }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${location.origin}/phoenix/v1/traces` }), { scheduledDelayMillis: 500 })],
});
const tracer = provider.getTracer("timeline-studio-chat");

export type Traced = { span: Span; ctx: Context };

/** Start a span of an OpenInference kind (AGENT / LLM / TOOL), optionally under a parent. */
export function start(name: string, kind: string, attrs: Record<string, any>, parent?: Traced): Traced {
  const span = tracer.startSpan(name, { attributes: { "openinference.span.kind": kind, ...flat(attrs) } }, parent?.ctx ?? context.active());
  return { span, ctx: trace.setSpan(parent?.ctx ?? context.active(), span) };
}

export function end(t: Traced, attrs: Record<string, any> = {}, error?: unknown) {
  t.span.setAttributes(flat(attrs));
  if (error) t.span.setStatus({ code: 2, message: String((error as any)?.message ?? error) });
  t.span.end();
}

/** OpenInference message lists are flattened attributes: llm.input_messages.0.message.role, ... */
export function messages(prefix: string, msgs: any[]) {
  const out: Record<string, any> = {};
  msgs.forEach((m, i) => {
    out[`${prefix}.${i}.message.role`] = m.role;
    if (m.content) out[`${prefix}.${i}.message.content`] = String(m.content);
    (m.tool_calls ?? []).forEach((c: any, j: number) => {
      out[`${prefix}.${i}.message.tool_calls.${j}.tool_call.function.name`] = c.function?.name;
      out[`${prefix}.${i}.message.tool_calls.${j}.tool_call.function.arguments`] = JSON.stringify(c.function?.arguments ?? {});
    });
  });
  return out;
}

const flat = (a: Record<string, any>) =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : v]));
