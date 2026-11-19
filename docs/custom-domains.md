# Custom domains

The proxy setup this page builds on is described in [Installation](installation.md#running-behind-nginx-proxy-manager).

An instance can answer on its own host name in addition to `<slug>.apps.example.com`, for example `notes.example.org`. The address under the apps domain stays and is the first URL of the instance.

**Who may do this:** By default only administrators. An administrator can switch the setting for custom domains in the administration area (Settings) to also allow publishers; then publishers may do it too. A publisher must also manage the instance, that is be its owner or a manager (`admin`). Administrators may handle the domains of any instance, without owning it or holding a grant: in the administration area under Apps (the link "Domains" per instance), through the same REST and MCP calls. You enter the domain on the instance page in the dashboard, with `PUT /api/instances/<slug>/domains` and the body `{"host": "notes.example.org"}` (plus `GET` and `DELETE`), or with the MCP tools `add_domain` and `remove_domain`. An instance can have at most 10 custom domains. A host name belongs to at most one instance on the whole server. The host name of the platform, `LAGER_APPS_DOMAIN` itself and all names under it (those are instance names) are not allowed, and neither is a parent domain of the platform host or of the apps domain: with the platform at `lager.example.com`, an instance cannot take `example.com`.

**Host name rules:** a DNS name of at least two labels made of letters, digits and hyphens (at most 253 characters in all), written in lower case or converted to it; one trailing dot is dropped. No port, no IP address (the last label must start with a letter), no wildcard and no underscore. Names ending in `.localhost`, `.local` or `.internal` are refused.

**Lager does not verify who owns the domain.** It only decides that requests with this host name go to the instance. Whoever may enter a domain can therefore claim any host name whose DNS points to your proxy. **The first account to add a host name keeps it:** nobody else can attach the same name to another instance until it is removed from the first one (by someone who manages that instance, or by an administrator), or until that instance is deleted. Grant the right with care, and leave it at administrators only if you do not trust your publishers.

The steps outside Lager:

1. DNS: create an A or CNAME record for the domain that points to your proxy.
2. Certificate: in Nginx Proxy Manager, request a certificate for this domain under "SSL Certificates → Add → Let's Encrypt" (the domain must already point to the proxy; a DNS challenge is needed only for wildcards).
3. Proxy host: in Nginx Proxy Manager create a proxy host for the domain: `http`, host of the container, port 8080, Websockets Support on, the certificate from step 2, Force SSL. The proxy must pass the `Host` header on unchanged (Nginx Proxy Manager does this by default). If apps on this domain use `lager.complete`, add the same `proxy_read_timeout` line on the "Advanced" tab as for the apps proxy host. Other proxies must meet the [reverse proxy requirements](installation.md#reverse-proxy-requirements).
4. Only then enter the domain in Lager.

**Sign-in:** Sign-in still goes through the platform (`LAGER_PUBLIC_URL`). A visitor without a session is sent from the custom domain to the platform, signs in there and returns with a one-time code to the domain they started on; the code is valid only for that host name. The instance cookie is per host name: someone who has opened the instance at `<slug>.apps.example.com` is not yet signed in on the custom domain and goes through the flow there once. Access rights are the same as under the apps domain. If you remove the domain or delete the instance, Lager answers requests for the host name with "not found".
