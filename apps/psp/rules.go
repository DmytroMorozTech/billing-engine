package main

import (
	"crypto/sha256"
	"encoding/hex"
	"time"
)

const (
	statusSucceeded = "succeeded"
	statusFailed    = "failed"

	declineInsufficientFunds = "insufficient_funds"
	declineCardExpired       = "card_expired"
)

// How long the deliberately slow amount takes. Longer than a comfortable HTTP
// timeout, because the point of it is to produce a job that looks stuck.
const slowDelay = 5 * time.Second

// Outcome is what the simulator decided, and why.
type Outcome struct {
	Status      string
	DeclineCode string
	Delay       time.Duration
}

// decide works out what happens to a charge.
//
// A pure function of the amount and the attempt number, with no randomness and
// no memory. That is the whole design of this service: a demo has to be able to
// promise "this payment fails twice and then goes through" and be right every
// time, and a test has to assert the same sequence without seeding anything.
//
// The last two digits of the minor amount choose the behaviour, in the spirit
// of a test card number. Any amount can therefore be made to fail without
// inventing a special merchant for it:
//
//	…01  never has the money, however often it is asked
//	…02  fails twice, then clears — the recovery story
//	…03  an expired card, which no amount of retrying fixes
//	…99  succeeds, slowly
//
// The attempt number arrives in the request rather than being counted here.
// Keeping it an argument is what keeps this a function: the dunning schedule
// already knows which attempt it is on, and a counter living in two places is a
// counter that will disagree with itself.
func decide(amountMinor int64, attempt int) Outcome {
	switch amountMinor % 100 {
	case 1:
		return Outcome{Status: statusFailed, DeclineCode: declineInsufficientFunds}
	case 2:
		if attempt >= 3 {
			return Outcome{Status: statusSucceeded}
		}
		return Outcome{Status: statusFailed, DeclineCode: declineInsufficientFunds}
	case 3:
		return Outcome{Status: statusFailed, DeclineCode: declineCardExpired}
	case 99:
		return Outcome{Status: statusSucceeded, Delay: slowDelay}
	default:
		return Outcome{Status: statusSucceeded}
	}
}

// chargeID derives an identifier from the idempotency key.
//
// Derived rather than stored, which is what lets this service keep no state at
// all: a retry of the same charge produces the same id because it is the same
// key, not because anything remembered it. A restarted container answers
// identically, which a demo relies on and a real provider's sandbox rarely
// offers.
func chargeID(idempotencyKey string) string {
	sum := sha256.Sum256([]byte(idempotencyKey))
	return "ch_" + hex.EncodeToString(sum[:])[:16]
}
