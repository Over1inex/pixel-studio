// The deployed service is API-only. The editor UI is embedded in the Windows EXE.
export function GET() {
  return Response.json({service:'Pixel Studio API',version:'1.0.0'}, {headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
