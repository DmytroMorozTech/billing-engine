// Command psp is a payment provider simulator.
//
// It stands in for the thing this system cannot own: an external provider that
// sometimes says no. Its refusals are decided by the amount and the attempt
// number and nothing else, so a dunning sequence plays out identically on every
// run — see rules.go.
//
// Go, and not part of the npm workspace, per ADR-0007. It is also the honest
// shape for a simulator: nothing here shares a type, a database or a deployment
// with the billing engine, which is exactly the relationship a real provider
// has with it.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const defaultPort = "8082"

func main() {
	port := os.Getenv("PSP_PORT")
	if port == "" {
		port = defaultPort
	}

	server := &http.Server{
		Addr:    ":" + port,
		Handler: newServer(),
		// Generous, because one rule deliberately takes five seconds. Below
		// that the simulator would time out its own slow case.
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		log.Printf("psp listening on %s", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("psp failed to start: %v", err)
		}
	}()

	<-stop
	log.Print("psp shutting down")

	// Long enough to let the slow rule finish the request it is in the middle
	// of, rather than cutting a charge off halfway through answering.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("psp shutdown was not clean: %v", err)
	}
}
