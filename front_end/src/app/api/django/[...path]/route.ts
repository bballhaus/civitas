/**
 * Proxy to Django backend. Keeps auth requests same-origin so session cookies work.
 * Forwards cookies to Django and passes Set-Cookie back to the browser.
 * Use DJANGO_API_URL if your backend runs elsewhere (e.g. in Docker use http://host.docker.internal:8000/api).
 */
const DJANGO_API =
  process.env.DJANGO_API_URL || "https://civitas-server.onrender.com/api";

async function proxy(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const pathStr = path.filter(Boolean).join("/");
  const trailingSlash = pathStr && !pathStr.endsWith("/") ? "/" : "";
  const query = request.url.includes("?") ? "?" + new URL(request.url).searchParams.toString() : "";
  const url = `${DJANGO_API}/${pathStr}${trailingSlash}${query}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() === "host") return;
    headers.set(key, value);
  });
  try {
    headers.set("Host", new URL(DJANGO_API).host);
  } catch {
    headers.set("Host", "localhost:8000");
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: request.method,
      headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Cannot reach backend. Is Django running on http://localhost:8000?" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const resHeaders = new Headers();
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      resHeaders.append(key, value);
    } else {
      resHeaders.set(key, value);
    }
  });

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: resHeaders,
  });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context);
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context);
}

export async function PATCH(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context);
}

export async function PUT(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context);
}

export async function DELETE(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context);
}
