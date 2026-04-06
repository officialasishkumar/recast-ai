package delivery

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"
)

// SendWebhook delivers a JSON payload to the given URL with an HMAC-SHA256
// signature in the X-Webhook-Signature header. It retries up to 3 times with
// exponential backoff on transient failures. A 5 second timeout applies to
// each individual attempt.
func SendWebhook(ctx context.Context, url, secret string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal webhook payload: %w", err)
	}

	sig := sign(body, secret)

	const maxAttempts = 3

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(math.Pow(2, float64(attempt))) * time.Second
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
		}

		lastErr = doPost(ctx, url, body, sig)
		if lastErr == nil {
			return nil
		}
	}

	return fmt.Errorf("webhook delivery failed after %d attempts: %w", maxAttempts, lastErr)
}

// doPost performs a single HTTP POST attempt with a 5 second timeout.
func doPost(ctx context.Context, url string, body []byte, signature string) error {
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Webhook-Signature", signature)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
	}
	defer func() {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}

	return fmt.Errorf("webhook returned status %d", resp.StatusCode)
}

// sign computes the HMAC-SHA256 hex digest of body using the given secret.
func sign(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
