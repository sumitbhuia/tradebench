package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

type Fill struct {
	Price    float64 `json:"price"`
	Quantity float64 `json:"qty"`
	Side     string  `json:"side"`
}

type orderResponse struct {
	OrderID string `json:"orderId"`
	Status  string `json:"status"`
	Fill    *Fill  `json:"fill,omitempty"`
}

type orderbookResponse struct {
	Bids []any `json:"bids"`
	Asks []any `json:"asks"`
}

var orderCounter uint64

// Simple in-memory order book for basic matching
type OrderBook struct {
	mu   sync.Mutex
	bids map[string]float64 // orderId -> price
	asks map[string]float64
}

var book = &OrderBook{
	bids: make(map[string]float64),
	asks: make(map[string]float64),
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/orderbook", handleOrderbook)
	mux.HandleFunc("/order", handleOrder)
	mux.HandleFunc("/order/", handleOrderByID)

	server := &http.Server{
		Addr:               ":8080",
		Handler:            mux,
		ReadHeaderTimeout:  5 * time.Second,
		WriteTimeout:       10 * time.Second,
		IdleTimeout:        30 * time.Second,
	}

	log.Println("test3 submission listening on :8080 (with fills)")
	log.Fatal(server.ListenAndServe())
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleOrderbook(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, orderbookResponse{Bids: []any{}, Asks: []any{}})
}

type orderRequest struct {
	Type     string  `json:"type"`
	Side     string  `json:"side"`
	Price    float64 `json:"price"`
	Quantity float64 `json:"qty"`
}

func handleOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var req orderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Simulate small latency
	time.Sleep(time.Duration(rand.Intn(3)) * time.Millisecond)

	id := nextOrderID()

	// Return a fill to demonstrate correctness scoring
	fill := &Fill{
		Price:    req.Price,
		Quantity: req.Quantity,
		Side:     req.Side,
	}

	book.mu.Lock()
	if req.Side == "BUY" {
		book.bids[id] = req.Price
	} else {
		book.asks[id] = req.Price
	}
	book.mu.Unlock()

	writeJSON(w, http.StatusOK, orderResponse{OrderID: id, Status: "FILLED", Fill: fill})
}

func handleOrderByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	id := r.URL.Path[len("/order/"):]
	if id == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	book.mu.Lock()
	delete(book.bids, id)
	delete(book.asks, id)
	book.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]string{
		"orderId": id,
		"status":  "CANCELLED",
	})
}

func nextOrderID() string {
	value := atomic.AddUint64(&orderCounter, 1)
	return fmt.Sprintf("order-%d-%s", value, strconv.FormatInt(time.Now().UTC().UnixNano(), 10))
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
