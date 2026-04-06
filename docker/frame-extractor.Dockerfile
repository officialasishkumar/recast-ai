FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /bin/frame-extractor ./cmd/frame-extractor

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata ffmpeg
COPY --from=builder /bin/frame-extractor /bin/frame-extractor

HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD pgrep frame-extractor || exit 1
ENTRYPOINT ["/bin/frame-extractor"]
