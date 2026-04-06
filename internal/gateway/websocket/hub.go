package websocket

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	gws "github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"

	"github.com/officialasishkumar/recast-ai/pkg/models"
)

// WebSocket upgrade settings.
var upgrader = gws.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// In production this should validate the Origin header against a
		// whitelist. For development we allow all origins.
		return true
	},
}

// client is an individual WebSocket connection watching a single job.
type client struct {
	conn  *gws.Conn
	send  chan []byte
	jobID string
}

// Hub manages per-job client sets and bridges Redis pub/sub events to
// connected WebSocket clients.
type Hub struct {
	mu      sync.RWMutex
	jobs    map[string]map[*client]struct{} // jobID -> set of clients
	redis   *redis.Client
	logger  *slog.Logger
	ctx     context.Context
	cancel  context.CancelFunc
	subs    map[string]*redis.PubSub // jobID -> active subscription
	subsMu  sync.Mutex
}

// NewHub creates a Hub. Call Run() in a separate goroutine.
func NewHub(rdb *redis.Client, logger *slog.Logger) *Hub {
	ctx, cancel := context.WithCancel(context.Background())
	return &Hub{
		jobs:   make(map[string]map[*client]struct{}),
		redis:  rdb,
		logger: logger,
		ctx:    ctx,
		cancel: cancel,
		subs:   make(map[string]*redis.PubSub),
	}
}

// Shutdown cleanly tears down all subscriptions and connections.
func (h *Hub) Shutdown() {
	h.cancel()

	h.subsMu.Lock()
	for _, ps := range h.subs {
		ps.Close() //nolint:errcheck
	}
	h.subsMu.Unlock()

	h.mu.Lock()
	for _, clients := range h.jobs {
		for c := range clients {
			close(c.send)
			c.conn.Close()
		}
	}
	h.mu.Unlock()
}

// HandleWS is the HTTP handler for GET /v1/ws/jobs/{id}. It upgrades the
// connection to WebSocket and registers the client with the hub.
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "id")
	if jobID == "" {
		http.Error(w, `{"error":"job id is required"}`, http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("ws upgrade failed", "error", err, "job_id", jobID)
		return
	}

	c := &client{
		conn:  conn,
		send:  make(chan []byte, 64),
		jobID: jobID,
	}

	h.register(c)
	go h.writePump(c)
	go h.readPump(c)
}

// register adds a client to the hub and ensures a Redis subscription exists
// for the job.
func (h *Hub) register(c *client) {
	h.mu.Lock()
	if h.jobs[c.jobID] == nil {
		h.jobs[c.jobID] = make(map[*client]struct{})
	}
	h.jobs[c.jobID][c] = struct{}{}
	h.mu.Unlock()

	// Ensure a Redis subscription is running for this job.
	h.subsMu.Lock()
	defer h.subsMu.Unlock()
	if _, exists := h.subs[c.jobID]; !exists {
		channel := "job:" + c.jobID + ":events"
		ps := h.redis.Subscribe(h.ctx, channel)
		h.subs[c.jobID] = ps
		go h.subscriptionLoop(c.jobID, ps)
		h.logger.Debug("subscribed to redis channel", "channel", channel)
	}
}

// unregister removes a client and tears down the Redis subscription if no
// clients remain for the job.
func (h *Hub) unregister(c *client) {
	h.mu.Lock()
	if clients, ok := h.jobs[c.jobID]; ok {
		delete(clients, c)
		if len(clients) == 0 {
			delete(h.jobs, c.jobID)
			// Tear down the subscription outside the lock.
			defer h.cleanupSub(c.jobID)
		}
	}
	h.mu.Unlock()
	close(c.send)
	c.conn.Close()
}

func (h *Hub) cleanupSub(jobID string) {
	h.subsMu.Lock()
	defer h.subsMu.Unlock()
	if ps, ok := h.subs[jobID]; ok {
		ps.Close() //nolint:errcheck
		delete(h.subs, jobID)
		h.logger.Debug("unsubscribed from redis channel", "channel", "job:"+jobID+":events")
	}
}

// subscriptionLoop reads messages from a Redis pub/sub channel and broadcasts
// them to every WebSocket client watching the job.
func (h *Hub) subscriptionLoop(jobID string, ps *redis.PubSub) {
	ch := ps.Channel()
	for {
		select {
		case <-h.ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			// Validate that the payload is a well-formed JobEvent.
			var evt models.JobEvent
			if err := json.Unmarshal([]byte(msg.Payload), &evt); err != nil {
				h.logger.Warn("invalid job event on redis channel", "error", err, "job_id", jobID)
				continue
			}
			h.broadcast(jobID, []byte(msg.Payload))
		}
	}
}

// broadcast sends a raw JSON message to every client watching the given job.
func (h *Hub) broadcast(jobID string, data []byte) {
	h.mu.RLock()
	clients := h.jobs[jobID]
	h.mu.RUnlock()

	for c := range clients {
		select {
		case c.send <- data:
		default:
			// Client is too slow; disconnect.
			h.logger.Warn("dropping slow ws client", "job_id", jobID)
			go h.unregister(c)
		}
	}
}

// writePump drains the client's send channel and writes messages to the
// WebSocket connection.
func (h *Hub) writePump(c *client) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	defer h.unregister(c)

	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				c.conn.WriteMessage(gws.CloseMessage, nil) //nolint:errcheck
				return
			}
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)) //nolint:errcheck
			if err := c.conn.WriteMessage(gws.TextMessage, msg); err != nil {
				h.logger.Debug("ws write error", "error", err, "job_id", c.jobID)
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)) //nolint:errcheck
			if err := c.conn.WriteMessage(gws.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// readPump reads (and discards) messages from the client. It exists only to
// detect connection closure.
func (h *Hub) readPump(c *client) {
	defer h.unregister(c)
	c.conn.SetReadLimit(512)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second)) //nolint:errcheck
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second)) //nolint:errcheck
		return nil
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			break
		}
	}
}
