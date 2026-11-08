FROM python:3.12-slim AS build
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir --prefix=/install .

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# The package itself is installed into site-packages by the build stage; nothing is imported from /app.
COPY --from=build /install /usr/local
# Config and prompt files ship with the image; changing them is a redeploy, not a code change.
COPY config ./config
COPY prompt ./prompt
ENV MODELS_CONFIG_PATH=/app/config/models.yaml PROMPT_DIR=/app/prompt
EXPOSE 8100
# Graceful shutdown must outlast the chat request limit (7-4-6): CHAT_REQUEST_TIMEOUT_SECONDS default 90.
CMD ["sh", "-c", "uvicorn chat_ai.app:app --host 0.0.0.0 --port ${PORT:-8100} --timeout-graceful-shutdown 120"]
