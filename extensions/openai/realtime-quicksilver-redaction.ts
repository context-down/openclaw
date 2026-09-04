import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

type OpenAIRealtimeSecretContext = {
  token: string;
  accountId?: string;
};

export function redactOpenAIRealtimeErrorDetail(
  text: string,
  auth: OpenAIRealtimeSecretContext | undefined,
  model?: string,
): string {
  let redacted = text;
  for (const secret of [auth?.token, auth?.accountId, model]) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redactSensitiveText(redacted, { mode: "tools" });
}

export function projectOpenAIQuicksilverErrorMessage(
  kind: "gateway" | "provider" | "transport",
): string {
  switch (kind) {
    case "gateway":
      return "OpenAI GPT-Live gateway relay failed";
    case "provider":
      return "OpenAI GPT-Live provider error";
    case "transport":
      return "OpenAI GPT-Live transport failed";
  }
}
