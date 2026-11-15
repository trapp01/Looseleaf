# Security

## Reporting a vulnerability

Please report it privately through
[GitHub's private vulnerability reporting](https://github.com/trapp01/Looseleaf/security/advisories/new),
not in a public issue. Say what you found, how to reproduce it and which
version or commit you tested.

Looseleaf is an early release maintained in spare time. Fixes land on `main`;
there are no maintained older versions yet.

## What the server protects against

The server is built for a private network such as a tailnet. One access token
keeps other devices on that network out. The token is not a substitute for TLS:
over plain `http` it travels unencrypted, so do not expose the port to the
internet without HTTPS in front of it.

Notes are stored unencrypted in the server's data folder and in each device's
browser storage. Anyone who can read those can read the notes.
