FROM golang:1.26-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /bin/mux-service ./cmd/mux-service

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata ffmpeg
COPY --from=builder /bin/mux-service /bin/mux-service

HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD pgrep mux-service || exit 1
ENTRYPOINT ["/bin/mux-service"]
