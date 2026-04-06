package storage

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/officialasishkumar/recast-ai/pkg/config"
)

// Client wraps a MinIO/S3 client.
type Client struct {
	mc     *minio.Client
	bucket string
	logger *slog.Logger
}

// New creates a new storage client, ensuring the bucket exists.
func New(cfg config.Storage, logger *slog.Logger) (*Client, error) {
	mc, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("create minio client: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Retry bucket creation — MinIO might not be ready yet.
	for i := 0; i < 15; i++ {
		exists, err := mc.BucketExists(ctx, cfg.Bucket)
		if err == nil {
			if !exists {
				if err := mc.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{Region: cfg.Region}); err != nil {
					logger.Warn("failed to create bucket, retrying", "error", err)
					time.Sleep(2 * time.Second)
					continue
				}
			}
			break
		}
		logger.Warn("minio not ready, retrying", "attempt", i+1, "error", err)
		time.Sleep(2 * time.Second)
	}

	logger.Info("storage connected", "endpoint", cfg.Endpoint, "bucket", cfg.Bucket)
	return &Client{mc: mc, bucket: cfg.Bucket, logger: logger}, nil
}

// Upload stores an object in the bucket.
func (c *Client) Upload(ctx context.Context, key string, reader io.Reader, size int64, contentType string) error {
	_, err := c.mc.PutObject(ctx, c.bucket, key, reader, size, minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return fmt.Errorf("upload %s: %w", key, err)
	}
	c.logger.Debug("uploaded object", "key", key, "size", size)
	return nil
}

// Download retrieves an object from the bucket.
func (c *Client) Download(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := c.mc.GetObject(ctx, c.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", key, err)
	}
	return obj, nil
}

// PresignedGetURL returns a temporary download URL.
func (c *Client) PresignedGetURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
	u, err := c.mc.PresignedGetObject(ctx, c.bucket, key, expiry, url.Values{})
	if err != nil {
		return "", fmt.Errorf("presign %s: %w", key, err)
	}
	return u.String(), nil
}

// Delete removes an object from the bucket.
func (c *Client) Delete(ctx context.Context, key string) error {
	return c.mc.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{})
}

// Stat returns object info (size, content type, etc.).
func (c *Client) Stat(ctx context.Context, key string) (minio.ObjectInfo, error) {
	return c.mc.StatObject(ctx, c.bucket, key, minio.StatObjectOptions{})
}

// UploadFile uploads a local file to the bucket.
func (c *Client) UploadFile(ctx context.Context, key, filePath, contentType string) error {
	_, err := c.mc.FPutObject(ctx, c.bucket, key, filePath, minio.PutObjectOptions{
		ContentType: contentType,
	})
	return err
}

// DownloadFile downloads an object to a local file.
func (c *Client) DownloadFile(ctx context.Context, key, filePath string) error {
	return c.mc.FGetObject(ctx, c.bucket, key, filePath, minio.GetObjectOptions{})
}
