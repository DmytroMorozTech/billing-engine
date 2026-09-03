package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func post(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(http.MethodPost, "/v1/charges", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	newServer().ServeHTTP(recorder, request)

	return recorder
}

func decode(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()

	var body map[string]any
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	return body
}

func TestChargeSucceeds(t *testing.T) {
	recorder := post(t, `{"idempotencyKey":"k1","amountMinor":14071,"currency":"EUR","reference":"invoice:42"}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body)
	}

	body := decode(t, recorder)
	if body["status"] != statusSucceeded {
		t.Errorf("status = %v, want %q", body["status"], statusSucceeded)
	}
	if _, present := body["declineCode"]; present {
		t.Errorf("a successful charge carries a decline code: %v", body)
	}
	if id, _ := body["id"].(string); id != chargeID("k1") {
		t.Errorf("id = %v, want the one derived from the key", body["id"])
	}
}

func TestChargeDeclines(t *testing.T) {
	recorder := post(t, `{"idempotencyKey":"k2","amountMinor":12301,"currency":"EUR","attempt":1}`)

	// A declined charge is a normal answer to a well-formed question, not an
	// HTTP error. Returning 402 here would make every client treat a routine
	// decline as a transport failure and retry it.
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body)
	}

	body := decode(t, recorder)
	if body["status"] != statusFailed {
		t.Errorf("status = %v, want %q", body["status"], statusFailed)
	}
	if body["declineCode"] != declineInsufficientFunds {
		t.Errorf("decline code = %v, want %q", body["declineCode"], declineInsufficientFunds)
	}
}

func TestSameKeyGivesTheSameCharge(t *testing.T) {
	first := decode(t, post(t, `{"idempotencyKey":"k3","amountMinor":12302,"currency":"EUR","attempt":1}`))
	again := decode(t, post(t, `{"idempotencyKey":"k3","amountMinor":12302,"currency":"EUR","attempt":1}`))

	if first["id"] != again["id"] || first["status"] != again["status"] {
		t.Errorf("retry answered differently: %v then %v", first, again)
	}
}

func TestAttemptChangesTheOutcome(t *testing.T) {
	failed := decode(t, post(t, `{"idempotencyKey":"k4","amountMinor":12302,"currency":"EUR","attempt":2}`))
	cleared := decode(t, post(t, `{"idempotencyKey":"k5","amountMinor":12302,"currency":"EUR","attempt":3}`))

	if failed["status"] != statusFailed {
		t.Errorf("attempt 2: status = %v, want %q", failed["status"], statusFailed)
	}
	if cleared["status"] != statusSucceeded {
		t.Errorf("attempt 3: status = %v, want %q", cleared["status"], statusSucceeded)
	}
}

func TestRejectsRequestsItCannotAnswer(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"no idempotency key", `{"amountMinor":100,"currency":"EUR"}`},
		{"amount of zero", `{"idempotencyKey":"k","amountMinor":0,"currency":"EUR"}`},
		{"negative amount", `{"idempotencyKey":"k","amountMinor":-100,"currency":"EUR"}`},
		{"no currency", `{"idempotencyKey":"k","amountMinor":100}`},
		{"not JSON at all", `{`},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if recorder := post(t, c.body); recorder.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", recorder.Code)
			}
		})
	}
}

func TestAmountIsAnInteger(t *testing.T) {
	// Minor units, always. A payload carrying 140.71 is rejected here rather
	// than being rounded into something plausible three services later.
	if recorder := post(t, `{"idempotencyKey":"k","amountMinor":140.71,"currency":"EUR"}`); recorder.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", recorder.Code)
	}
}

func TestHealth(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()
	newServer().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", recorder.Code)
	}
}

func TestUnknownRoute(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/v1/nope", nil)
	recorder := httptest.NewRecorder()
	newServer().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", recorder.Code)
	}
}

func TestGetIsNotACharge(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/v1/charges", bytes.NewReader(nil))
	recorder := httptest.NewRecorder()
	newServer().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", recorder.Code)
	}
}
