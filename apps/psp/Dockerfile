# syntax=docker/dockerfile:1

# The simulator builds from its own directory, not the repository root: it
# shares no code with the workspace and nothing here should tempt it to
# (ADR-0007).

FROM golang:1.27-alpine AS build
WORKDIR /src

# No third-party dependencies at all — go.mod alone is the manifest, and
# `go mod download` has nothing to fetch. Kept as its own layer anyway, so
# adding one later does not re-download on every source edit.
COPY go.mod ./
RUN go mod download

COPY *.go ./
RUN go vet ./... && go test ./...

# Static, so the runtime stage needs no libc at all.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/psp .

# Nothing but the binary. No shell, no package manager, nothing to exploit and
# nothing to patch — the simulator has no reason to contain a userland.
FROM scratch AS runtime
COPY --from=build /out/psp /psp

EXPOSE 8082
USER 65534:65534

ENTRYPOINT ["/psp"]
