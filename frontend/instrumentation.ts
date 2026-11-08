import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
const logsUrl = posthogHost
  ? `${posthogHost.replace(/\/$/, "")}/i/v1/logs`
  : undefined;

export const loggerProvider =
  posthogKey && logsUrl
    ? new LoggerProvider({
        resource: resourceFromAttributes({ "service.name": "dopia-frontend" }),
        processors: [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({
              url: logsUrl,
              headers: {
                Authorization: `Bearer ${posthogKey}`,
                "Content-Type": "application/json",
              },
              timeoutMillis: 2_000,
            }),
          }),
        ],
      })
    : undefined;

// Use this dedicated logger only for log lines introduced by the PostHog integration.
export const posthogLogger = loggerProvider?.getLogger("dopia-frontend-posthog");

export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (!posthogKey && process.env.NODE_ENV !== "production") {
    console.warn(
      "NEXT_PUBLIC_POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_KEY is configured",
    );
  }
  if (!posthogHost && process.env.NODE_ENV !== "production") {
    console.warn(
      "NEXT_PUBLIC_POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_HOST is configured",
    );
  }

  posthogLogger?.emit({
    body: "PostHog log exporter initialized",
    severityNumber: SeverityNumber.INFO,
  });
}
