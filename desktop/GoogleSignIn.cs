using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web;
using System.Web.Script.Serialization;

internal static class GoogleSignIn {
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static string RandomValue() { byte[] bytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes); return Base64Url(bytes); }
    private static string Base64Url(byte[] bytes) { return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_'); }
    private static string Param(string value) { return Uri.EscapeDataString(value); }
    internal static async Task<Cookie> Login(string address) {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        var origin = new Uri(new Uri(address).GetLeftPart(UriPartial.Authority));
        using (var handler = new HttpClientHandler { CookieContainer = new CookieContainer(), AllowAutoRedirect = false })
        using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(25) }) {
            Dictionary<string,object> config;
            using (var configRequest = new HttpRequestMessage(HttpMethod.Get, new Uri(origin,"/api/auth/config"))) {
                DesktopApp.AddServiceAccess(configRequest, origin);
                using (var configResponse = await client.SendAsync(configRequest)) {
                    if (!configResponse.IsSuccessStatusCode) throw new Exception("Облачный вход пока недоступен. Дождитесь настройки Google владельцем приложения.");
                    config = Json.Deserialize<Dictionary<string,object>>(await configResponse.Content.ReadAsStringAsync());
                }
            }
            object clientValue;
            if (!config.TryGetValue("googleClientId",out clientValue) || clientValue == null || string.IsNullOrWhiteSpace(clientValue.ToString())) throw new Exception("Вход Google ещё не настроен. Владелец должен указать Google OAuth Client ID типа Desktop app в настройках сервера.");
            string clientId = clientValue.ToString();
            if (!clientId.EndsWith(".apps.googleusercontent.com",StringComparison.Ordinal)) throw new Exception("Некорректный Google Client ID в настройках сервера.");
            string state = RandomValue(), nonce = RandomValue(), verifier = RandomValue(), challenge;
            using (var hash = SHA256.Create()) challenge = Base64Url(hash.ComputeHash(Encoding.ASCII.GetBytes(verifier)));
            var listener = new TcpListener(IPAddress.Loopback,0);
            listener.Start();
            try {
                string redirect = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/";
                string authorization = "https://accounts.google.com/o/oauth2/v2/auth?client_id="+Param(clientId)+"&redirect_uri="+Param(redirect)+"&response_type=code&scope=openid%20email%20profile&state="+Param(state)+"&nonce="+Param(nonce)+"&code_challenge_method=S256&code_challenge="+Param(challenge)+"&prompt=select_account";
                Process.Start(new ProcessStartInfo(authorization){UseShellExecute=true});
                var deadline = DateTime.UtcNow.AddMinutes(3);
                while (DateTime.UtcNow < deadline) {
                    var accepted = listener.AcceptTcpClientAsync();
                    TimeSpan remaining = deadline - DateTime.UtcNow;
                    if (remaining <= TimeSpan.Zero || await Task.WhenAny(accepted,Task.Delay(remaining)) != accepted) throw new Exception("Время ожидания Google истекло. Попробуйте войти снова.");
                    using (var connection = await accepted)
                    using (var stream = connection.GetStream()) {
                        var reader = new StreamReader(stream,Encoding.ASCII,false,1024,true);
                        var firstLineTask = reader.ReadLineAsync();
                        if (await Task.WhenAny(firstLineTask,Task.Delay(5000)) != firstLineTask) continue;
                        string firstLine = await firstLineTask;
                        if (firstLine == null || firstLine.Length>8192 || !firstLine.StartsWith("GET /?",StringComparison.Ordinal)) { await Reply(stream,"Запрос не распознан."); continue; }
                        string[] pieces=firstLine.Split(' '); if(pieces.Length!=3)continue;
                        var callback=new Uri(new Uri(redirect),pieces[1]);
                        var query=HttpUtility.ParseQueryString(callback.Query);
                        if(callback.AbsolutePath!="/" || query["state"]!=state) { await Reply(stream,"Этот запрос входа недействителен. Вернитесь в приложение."); continue; }
                        if(!string.IsNullOrEmpty(query["error"])) { await Reply(stream,"Вход отменён. Можно закрыть эту вкладку."); throw new Exception("Вход Google отменён."); }
                        string code=query["code"];if(string.IsNullOrEmpty(code)){await Reply(stream,"Google не передал код входа.");continue;}
                        var body = Json.Serialize(new Dictionary<string,string>{{"code",code},{"codeVerifier",verifier},{"redirectUri",redirect},{"nonce",nonce}});
                        using(var request=new HttpRequestMessage(HttpMethod.Post,new Uri(origin,"/api/auth/google"))) {
                            DesktopApp.AddServiceAccess(request, origin);
                            request.Headers.Add("Origin",origin.GetLeftPart(UriPartial.Authority));
                            request.Content=new StringContent(body,Encoding.UTF8,"application/json");
                            var result=await client.SendAsync(request);
                            if(!result.IsSuccessStatusCode) {
                                await Reply(stream,"Не удалось завершить вход. Вернитесь в приложение.");
                                string message="Не удалось завершить вход Google.";
                                try {var error=Json.Deserialize<Dictionary<string,object>>(await result.Content.ReadAsStringAsync());if(error.ContainsKey("error"))message=error["error"].ToString();}catch{}
                                throw new Exception(message);
                            }
                            var session=handler.CookieContainer.GetCookies(origin)["pixel_session"];
                            if(session==null)throw new Exception("Сервер не создал сеанс входа.");
                            await Reply(stream,"Вход завершён. Вернитесь в Pixel Studio — эту вкладку можно закрыть.");
                            return session;
                        }
                    }
                }
                throw new Exception("Время ожидания входа истекло.");
            } finally { listener.Stop(); }
        }
    }
    private static async Task Reply(NetworkStream stream,string message) {
        byte[] body=Encoding.UTF8.GetBytes("<!doctype html><meta charset='utf-8'><title>Pixel Studio</title><body style='background:#16181b;color:#e8e9ec;font:18px system-ui;padding:10vw'><h1 style='color:#c2f575'>Pixel Studio</h1><p>"+HttpUtility.HtmlEncode(message)+"</p>");
        byte[] header=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: "+body.Length+"\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(header,0,header.Length);await stream.WriteAsync(body,0,body.Length);
    }
}
