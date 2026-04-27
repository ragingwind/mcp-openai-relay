export const runtime = "nodejs";
export const maxDuration = 300;

const placeholder = (): Response =>
  new Response(JSON.stringify({ error: "not_implemented", message: "Wired in #5" }), {
    status: 501,
    headers: { "content-type": "application/json" },
  });

export const GET = placeholder;
export const POST = placeholder;
export const DELETE = placeholder;
