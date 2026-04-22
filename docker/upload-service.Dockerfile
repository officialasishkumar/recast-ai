FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /bin/upload-service ./cmd/upload-service

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /bin/upload-service /bin/upload-service

EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://localhost:8081/health || exit 1
ENTRYPOINT ["/bin/upload-service"]
