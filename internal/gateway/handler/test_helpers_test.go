package handler

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"

	"github.com/jmoiron/sqlx"

	"github.com/officialasishkumar/recast-ai/pkg/auth"
	"github.com/officialasishkumar/recast-ai/pkg/config"

	mw "github.com/officialasishkumar/recast-ai/internal/gateway/middleware"
)

// ---------- fake SQL driver ----------
//
// The fake driver lets tests stage response rows per SQL query fragment. It is
// registered once and shared across the suite. Tests acquire a fresh sqlx.DB
// via newFakeDB and set up expectations via fakeDriver.On.

type fakeRow struct {
	cols []string
	vals []driver.Value
}

type fakeResult struct {
	rows []fakeRow
	exec struct {
		lastInsertID int64
		rowsAffected int64
	}
	err error
}

type fakeExpectation struct {
	// matcher returns true if this expectation applies to the given query.
	matcher func(query string, args []driver.NamedValue) bool
	// result is returned on match. Consumed once unless reusable is true.
	result   fakeResult
	reusable bool
}

type fakeDriver struct {
	mu           sync.Mutex
	expectations []*fakeExpectation
}

var (
	fakeDriverOnce sync.Once
	sharedDriver   = &fakeDriver{}
)

func registerFakeDriver() {
	fakeDriverOnce.Do(func() {
		sql.Register("recastfake", sharedDriver)
	})
}

func (d *fakeDriver) Open(name string) (driver.Conn, error) {
	return &fakeConn{driver: d}, nil
}

// On registers an expectation that matches queries containing the given
// substring. Optional reusable flag allows the expectation to fire multiple
// times.
func (d *fakeDriver) On(containsFragment string, r fakeResult, reusable bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.expectations = append(d.expectations, &fakeExpectation{
		matcher: func(q string, _ []driver.NamedValue) bool {
			return strings.Contains(q, containsFragment)
		},
		result:   r,
		reusable: reusable,
	})
}

// Reset clears all expectations.
func (d *fakeDriver) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.expectations = nil
}

func (d *fakeDriver) match(query string, args []driver.NamedValue) (fakeResult, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i, e := range d.expectations {
		if e.matcher(query, args) {
			res := e.result
			if !e.reusable {
				d.expectations = append(d.expectations[:i], d.expectations[i+1:]...)
			}
			return res, true
		}
	}
	return fakeResult{}, false
}

type fakeConn struct {
	driver *fakeDriver
}

func (c *fakeConn) Prepare(query string) (driver.Stmt, error) {
	return &fakeStmt{conn: c, query: query}, nil
}

func (c *fakeConn) Close() error                                     { return nil }
func (c *fakeConn) Begin() (driver.Tx, error)                        { return &fakeTx{}, nil }
func (c *fakeConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	return &fakeTx{}, nil
}

// QueryContext / ExecContext fast-path (skips Prepare).
func (c *fakeConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	r, ok := c.driver.match(query, args)
	if !ok {
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
	if r.err != nil {
		return nil, r.err
	}
	return &fakeRows{cols: columnsOf(r.rows), rows: r.rows}, nil
}

func (c *fakeConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	r, ok := c.driver.match(query, args)
	if !ok {
		return nil, fmt.Errorf("unexpected exec: %s", query)
	}
	if r.err != nil {
		return nil, r.err
	}
	return driverResult{lastInsert: r.exec.lastInsertID, affected: r.exec.rowsAffected}, nil
}

type driverResult struct {
	lastInsert int64
	affected   int64
}

func (r driverResult) LastInsertId() (int64, error) { return r.lastInsert, nil }
func (r driverResult) RowsAffected() (int64, error) { return r.affected, nil }

type fakeStmt struct {
	conn  *fakeConn
	query string
}

func (s *fakeStmt) Close() error  { return nil }
func (s *fakeStmt) NumInput() int { return -1 }

func (s *fakeStmt) Exec(args []driver.Value) (driver.Result, error) {
	named := toNamed(args)
	return s.conn.ExecContext(context.Background(), s.query, named)
}

func (s *fakeStmt) Query(args []driver.Value) (driver.Rows, error) {
	named := toNamed(args)
	return s.conn.QueryContext(context.Background(), s.query, named)
}

func toNamed(args []driver.Value) []driver.NamedValue {
	out := make([]driver.NamedValue, len(args))
	for i, v := range args {
		out[i] = driver.NamedValue{Ordinal: i + 1, Value: v}
	}
	return out
}

type fakeTx struct{}

func (t *fakeTx) Commit() error   { return nil }
func (t *fakeTx) Rollback() error { return nil }

type fakeRows struct {
	cols []string
	rows []fakeRow
	idx  int
}

func (r *fakeRows) Columns() []string { return r.cols }
func (r *fakeRows) Close() error      { return nil }
func (r *fakeRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.idx]
	r.idx++
	// Map row values to the column indices. The caller expects values in cols order.
	for i := range dest {
		if i < len(row.vals) {
			dest[i] = row.vals[i]
		} else {
			dest[i] = nil
		}
	}
	return nil
}

func columnsOf(rows []fakeRow) []string {
	if len(rows) == 0 {
		return nil
	}
	return rows[0].cols
}

// newFakeDB returns a fresh sqlx.DB backed by the shared fake driver. It also
// resets the driver's expectations so each test starts clean.
func newFakeDB(t interface{ Fatalf(string, ...any) }) *sqlx.DB {
	registerFakeDriver()
	sharedDriver.Reset()
	db, err := sql.Open("recastfake", "")
	if err != nil {
		t.Fatalf("open fake db: %v", err)
	}
	return sqlx.NewDb(db, "postgres")
}

// ---------- fake publisher ----------

type fakePublisher struct {
	published []publishedMsg
	err       error
}

type publishedMsg struct {
	Queue   string
	Message any
}

func (p *fakePublisher) Publish(_ context.Context, queueName string, msg any) error {
	if p.err != nil {
		return p.err
	}
	p.published = append(p.published, publishedMsg{Queue: queueName, Message: msg})
	return nil
}

// ---------- helpers ----------

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newDeps builds a Deps wired with the fake DB and publisher.
func newDeps(db *sqlx.DB, pub *fakePublisher) *Deps {
	return &Deps{
		DB:      db,
		Queue:   pub,
		AuthCfg: config.Auth{JWTSecret: "test-secret"},
		Logger:  testLogger(),
	}
}

// ctxWithClaims returns a context containing the given claims, simulating the
// JWTAuth middleware's attachment step.
func ctxWithClaims(userID, role string) context.Context {
	return mw.WithClaims(context.Background(), &auth.Claims{UserID: userID, Role: role})
}
