using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
internal static class DesktopApp { internal const string Version="0.2.1";internal static string DataDirectory=Path.GetTempPath(); }
internal sealed class FixtureHandler:HttpMessageHandler {
 internal Func<HttpRequestMessage,HttpResponseMessage> Response;
 protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation){
  if(request.Headers.Contains("Cookie")||request.Headers.Contains("OAI-Sites-Authorization")||request.Headers.Authorization!=null)throw new Exception("Credentials leaked to updater");
  return Task.FromResult(Response(request));
 }
}
internal static class UpdaterTests {
 private static readonly JavaScriptSerializer Json=new JavaScriptSerializer();private static int checks;
 private static void Check(bool value,string label){if(!value)throw new Exception(label);checks++;}
 private static Dictionary<string,object> Metadata(byte[] bytes,string version="0.2.2",string overrideUrl=null,string overrideDigest=null){
  return Json.Deserialize<Dictionary<string,object>>(Json.Serialize(new{tag_name="v"+version,draft=false,prerelease=false,assets=new[]{new{name="Pixel-Studio-"+version+"-Windows.zip",browser_download_url=overrideUrl??"https://github.com/Over1inex/pixel-studio/releases/download/v"+version+"/Pixel-Studio-"+version+"-Windows.zip",digest=overrideDigest??"sha256:"+DesktopUpdater.Hash(bytes),size=bytes.Length}}}));
 }
 private static byte[] Package(string root,bool invalid=false){using(var stream=new MemoryStream()){
  using(var zip=new ZipArchive(stream,ZipArchiveMode.Create,true)){
   foreach(string name in new[]{"Pixel Studio.exe","Удалить Pixel Studio.exe"}){var entry=zip.CreateEntry("Pixel Studio/"+name);using(var output=entry.Open()){var b=File.ReadAllBytes(Path.Combine(root,name));output.Write(b,0,b.Length);}}
   if(invalid){using(var output=new StreamWriter(zip.CreateEntry("Pixel Studio/../escape.exe").Open()))output.Write("unsafe");}
  }return stream.ToArray();
 }}
 private static DesktopUpdater Updater(string root,byte[] advertised,byte[] downloaded=null,bool redirect=false){
  var handler=new FixtureHandler();handler.Response=request=>{
   if(request.RequestUri.AbsoluteUri==DesktopUpdater.ReleaseApi)return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(Json.Serialize(Metadata(advertised)),Encoding.UTF8,"application/json")};
   if(redirect){var response=new HttpResponseMessage(HttpStatusCode.Redirect);response.Headers.Location=new Uri("https://untrusted.example/evil.zip");return response;}
   return new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(downloaded??advertised)};
  };
  return new DesktopUpdater(new HttpClient(handler),Path.Combine(root,Guid.NewGuid().ToString("N")),Path.Combine(root,"installed.exe"));
 }
 private static string Phase(DesktopUpdater updater){return Json.Deserialize<Dictionary<string,object>>(updater.StatusJson())["phase"].ToString();}
 public static int Main(string[] args){try{Run(args[0]).GetAwaiter().GetResult();Console.WriteLine("Updater: "+checks+" checks passed.");return 0;}catch(Exception error){Console.Error.WriteLine(error);return 1;}}
 private static async Task Run(string root){
  var bytes=Package(root);Check(DesktopUpdater.ReadRelease(Metadata(bytes),new Version("0.2.1")).Version=="0.2.2","new release recognized");
  Check(DesktopUpdater.ReadRelease(Metadata(bytes,"0.2.0"),new Version("0.2.1"))==null,"downgrade ignored");
  foreach(var bad in new[]{Metadata(bytes,overrideUrl:"https://github.com/other/repo/file.zip"),Metadata(bytes,overrideDigest:"sha256:bad")}){bool rejected=false;try{DesktopUpdater.ReadRelease(bad,new Version("0.2.1"));}catch(InvalidDataException){rejected=true;}Check(rejected,"metadata rejected");}
  Check(!DesktopUpdater.IsDownloadHost(new Uri("http://github.com/file")),"HTTPS required");Check(!DesktopUpdater.IsDownloadHost(new Uri("https://github.com.evil.example/file")),"host suffix rejected");
  var installed=Path.Combine(root,"installed.exe");File.WriteAllText(installed,"original installed version");
  var updater=Updater(root,bytes);await updater.CheckAsync();Check(Phase(updater)=="available","check finds update");await updater.DownloadAsync();Check(Phase(updater)=="ready","valid package staged");Check(File.ReadAllText(installed)=="original installed version","running EXE unchanged");updater.Cancel();Check(Phase(updater)=="available","postpone cancels installation");
  var tampered=(byte[])bytes.Clone();tampered[tampered.Length/2]^=1;
  var corrupt=Updater(root,bytes,tampered);await corrupt.CheckAsync();await corrupt.DownloadAsync();Check(Phase(corrupt)=="error","modified archive denied");
  var traversal=Updater(root,Package(root,true));await traversal.CheckAsync();await traversal.DownloadAsync();Check(Phase(traversal)=="error","ZIP traversal denied");Check(!File.Exists(Path.Combine(root,"escape.exe")),"no escaped file");
  var redirected=Updater(root,bytes,redirect:true);await redirected.CheckAsync();await redirected.DownloadAsync();Check(Phase(redirected)=="error","untrusted redirect denied");Check(File.ReadAllText(installed)=="original installed version","failed updates preserve current app");
 }
}
