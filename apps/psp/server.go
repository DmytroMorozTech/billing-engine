package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

// chargeRequest is what the billing system asks for.
//
// amountMinor is an integer in the currency's minor unit, the same rule the
// rest of the system follows (ADR-0001): 14071 is €140.71. json.Number is used
// so that 140.71 is rejected rather than quietly truncated — a float that
// reaches a payment request has already lost the argument.
type chargeRequest struct {
	IdempotencyKey string      `json:"idempotencyKey"`
	AmountMinor    json.Number `json:"amountMinor"`
	Currency       string      `json:"currency"`
	Reference      string      `json:"reference"`
	// Which attempt of the dunning sequence this is. Absent means the first.
	Attempt int `json:"attempt"`
}

type chargeResponse struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	DeclineCode string `json:"declineCode,omitempty"`
	Reference   string `json:"reference,omitempty"`
	ProcessedAt string `json:"processedAt"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// newServer wires the routes.
//
// Standard library only. This is 200 lines of simulator behind an HTTP
// interface; a framework here would be more code to read, not less.
func newServer() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/charges", handleCharge)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	return mux
}

func handleCharge(w http.ResponseWriter, r *http.Request) {
	var request chargeRequest
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	if err := decoder.Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "body is not valid JSON"})
		return
	}

	amount, err := validate(request)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: err.Error()})
		return
	}

	attempt := request.Attempt
	if attempt < 1 {
		attempt = 1
	}

	outcome := decide(amount, attempt)
	if outcome.Delay > 0 {
		// Deliberately slow, so there is something for the stuck-jobs screen
		// to show. Cut short if the caller gives up first.
		select {
		case <-time.After(outcome.Delay):
		case <-r.Context().Done():
			return
		}
	}

	// A decline is a well-formed answer to a well-formed question, so it
	// leaves as 200. Returning 402 would have every client treat a routine
	// "no money on the card" as a transport failure and retry it.
	writeJSON(w, http.StatusOK, chargeResponse{
		ID:          chargeID(request.IdempotencyKey),
		Status:      outcome.Status,
		DeclineCode: outcome.DeclineCode,
		Reference:   request.Reference,
		ProcessedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func validate(request chargeRequest) (int64, error) {
	if request.IdempotencyKey == "" {
		return 0, errors.New("idempotencyKey is required: a retried charge must not become a second one")
	}
	if request.Currency == "" {
		return 0, errors.New("currency is required")
	}

	amount, err := request.AmountMinor.Int64()
	if err != nil {
		return 0, errors.New("amountMinor must be a whole number of minor units, e.g. 14071 for €140.71")
	}
	if amount <= 0 {
		return 0, errors.New("amountMinor must be above zero")
	}

	return amount, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
