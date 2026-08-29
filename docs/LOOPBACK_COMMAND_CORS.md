# Loopback Command CORS Boundary

## Purpose

The browser MVP talks to the local command server from an exact allowlisted browser origin. Browsers therefore require CORS preflight support for the JSON command request and the custom `x-interview-client-token` header.

CORS is a transport permission layer only. It does not replace command authentication.

## Endpoint

The CORS policy applies to:

```text
/v1/commands
```

The only allowed application method is:

```text
POST
```

Preflight itself uses `OPTIONS`, but `OPTIONS` never enters command parsing or dispatch.

## Exact Origin policy

Every browser request must carry an `Origin` that exactly matches one member of `LocalTransportSecurity.allowedOrigins`.

The server never emits:

```text
Access-Control-Allow-Origin: *
```

It returns the exact allowed origin only after that origin passes the allowlist check.

Rejected or missing origins receive no `Access-Control-Allow-Origin` header.

Actual command requests continue to require the dedicated `x-interview-client-token` credential in addition to the exact origin.

## Preflight

A valid preflight requires:

- request path exactly `/v1/commands`;
- exact allowlisted `Origin`;
- `Access-Control-Request-Method: POST`;
- every requested non-simple header, if present, to be one of:
  - `content-type`;
  - `x-interview-client-token`.

Header-name comparison is case-insensitive.

Successful preflight returns:

```text
204 No Content
Access-Control-Allow-Origin: <exact allowed origin>
Access-Control-Allow-Methods: POST
Access-Control-Allow-Headers: content-type, x-interview-client-token
Access-Control-Max-Age: 300
Cache-Control: no-store
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers
```

It intentionally does not return `Access-Control-Allow-Credentials`. The transport uses the dedicated header token rather than browser cookies or ambient credentials.

The client token is **not required on preflight**. Standard browser preflight requests do not send the eventual authorization header value. Preflight authorizes only the origin, requested method, and requested header names.

## Actual command responses

For an allowed origin, both successful command responses and protocol errors include:

```text
Access-Control-Allow-Origin: <exact allowed origin>
Vary: Origin
```

This allows the legitimate browser UI to read a `401`, `415`, or other protocol response and react appropriately.

An untrusted origin is never reflected into the response.

Actual command dispatch still happens only after:

1. the client token passes timing-safe comparison;
2. the exact origin passes the allowlist;
3. method and path are valid;
4. content type and command schema are valid.

## Mutation boundary

Preflight performs no:

- registry lookup;
- session recovery;
- SessionWriter call;
- event append;
- delivery mutation;
- command dispatch.

Rejected preflight and rejected actual requests likewise do not mutate authoritative session state.

## Security limits

CORS does not prove that a client is trusted. It is a browser enforcement mechanism layered on top of the existing local authentication boundary.

The security model remains:

```text
loopback binding
+ exact browser Origin
+ dedicated high-entropy client token
+ strict command schema
```

No token is placed in a URL, request body, CORS allowlist header, or CORS response metadata.

This slice introduces no provider credentials and no paid API requirement.
