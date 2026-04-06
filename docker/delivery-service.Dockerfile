FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /bin/delivery-service ./cmd/delivery-service

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /bin/delivery-service /bin/delivery-service

HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD pgrep delivery-service || exit 1
ENTRYPOINT ["/bin/delivery-service"]
