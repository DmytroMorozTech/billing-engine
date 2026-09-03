package main

import (
	"testing"
	"time"
)

// The rules exist so that a demo and a test can both say "this payment fails,
// twice, and then goes through" and mean it. Anything random here would make
// the dunning sequence unreproducible, which is the one property the whole
// virtual clock was built for.
func TestDecide(t *testing.T) {
	cases := []struct {
		name        string
		amountMinor int64
		attempt     int
		wantStatus  string
		wantCode    string
	}{
		{"ordinary amount goes through", 14071, 1, statusSucceeded, ""},
		{"…01 never has the money", 12301, 1, statusFailed, declineInsufficientFunds},
		{"…01 still has none on the fourth try", 12301, 4, statusFailed, declineInsufficientFunds},
		{"…02 fails the first attempt", 12302, 1, statusFailed, declineInsufficientFunds},
		{"…02 fails the second", 12302, 2, statusFailed, declineInsufficientFunds},
		{"…02 clears on the third", 12302, 3, statusSucceeded, ""},
		{"…03 is an expired card, which retrying cannot fix", 12303, 1, statusFailed, declineCardExpired},
		{"…03 is still expired later", 12303, 9, statusFailed, declineCardExpired},
		{"…99 succeeds, slowly", 12399, 1, statusSucceeded, ""},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := decide(c.amountMinor, c.attempt)

			if got.Status != c.wantStatus {
				t.Errorf("status = %q, want %q", got.Status, c.wantStatus)
			}
			if got.DeclineCode != c.wantCode {
				t.Errorf("decline code = %q, want %q", got.DeclineCode, c.wantCode)
			}
		})
	}
}

func TestDecideIsSlowOnlyForTheSlowAmount(t *testing.T) {
	// The one rule that is about time rather than money: it exists so the
	// support console's stuck-jobs screen has something real to show.
	if delay := decide(12399, 1).Delay; delay != slowDelay {
		t.Errorf("delay for …99 = %v, want %v", delay, slowDelay)
	}
	if delay := decide(14071, 1).Delay; delay != time.Duration(0) {
		t.Errorf("delay for an ordinary amount = %v, want 0", delay)
	}
}

func TestDecideIgnoresTheMajorPart(t *testing.T) {
	// Only the last two digits choose the outcome, so any amount can be made
	// to fail in a demo without inventing a merchant for it.
	for _, amount := range []int64{1, 101, 999901, 100000001} {
		if got := decide(amount, 1); got.Status != statusFailed {
			t.Errorf("amount %d: status = %q, want %q", amount, got.Status, statusFailed)
		}
	}
}

func TestChargeIDIsDerivedFromTheIdempotencyKey(t *testing.T) {
	// No storage anywhere in this service. A retried charge returns the same
	// id because the id is a function of the key, not a row someone kept.
	first := chargeID("attempt-1-invoice-42")
	again := chargeID("attempt-1-invoice-42")
	other := chargeID("attempt-2-invoice-42")

	if first != again {
		t.Errorf("same key produced %q then %q", first, again)
	}
	if first == other {
		t.Errorf("different keys both produced %q", first)
	}
	if len(first) != len("ch_")+16 {
		t.Errorf("id %q is not the documented shape", first)
	}
}
