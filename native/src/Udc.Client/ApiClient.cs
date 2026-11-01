using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Udc.Client.Models;

namespace Udc.Client;

/// <summary>
/// Thin wrapper over the backend's existing <c>/api/mobile/*</c> REST API - the same API the
/// Android app uses. All business logic stays server-side; this just sends requests and unwraps
/// the <c>{"success":true,"data":...}</c> / <c>{"success":false,"error":{...}}</c> envelope.
/// </summary>
public sealed class ApiClient : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http;

    public string? BearerToken { get; set; }

    public ApiClient(string baseUrl) : this(baseUrl, new HttpClientHandler())
    {
    }

    /// <summary>Test hook: inject a fake <see cref="HttpMessageHandler"/> instead of hitting the network.</summary>
    public ApiClient(string baseUrl, HttpMessageHandler handler)
    {
        _http = new HttpClient(handler) { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(20) };
    }

    private void ApplyAuth(HttpRequestMessage req)
    {
        if (!string.IsNullOrEmpty(BearerToken))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", BearerToken);
    }

    private async Task<T> SendAsync<T>(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, path);
        ApplyAuth(req);
        if (body is not null) req.Content = JsonContent.Create(body, options: JsonOptions);

        HttpResponseMessage resp;
        try
        {
            resp = await _http.SendAsync(req, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            throw new ApiException("network_error", "Could not reach the local server. Is it still running?", ex);
        }

        var json = await resp.Content.ReadAsStringAsync(ct);
        ApiEnvelope<T>? envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<ApiEnvelope<T>>(json, JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new ApiException("bad_response", $"Unexpected response from server (HTTP {(int)resp.StatusCode}).", ex);
        }

        if (envelope is null)
            throw new ApiException("bad_response", $"Empty response from server (HTTP {(int)resp.StatusCode}).");
        if (!envelope.Success)
            throw new ApiException(envelope.Error?.Code ?? "unknown_error", envelope.Error?.Message ?? "Unknown error.");
        if (resp.StatusCode == HttpStatusCode.NoContent || envelope.Data is null)
            return default!;
        return envelope.Data;
    }

    public Task<LoginResult> LoginAsync(string username, string password, string deviceName, CancellationToken ct = default) =>
        SendAsync<LoginResult>(HttpMethod.Post, "/api/mobile/login", new
        {
            username,
            password,
            device_name = deviceName,
            device_id = Environment.MachineName,
        }, ct);

    public Task LogoutAsync(CancellationToken ct = default) =>
        SendAsync<object>(HttpMethod.Post, "/api/mobile/logout", null, ct);

    public Task<MeResult> GetMeAsync(CancellationToken ct = default) =>
        SendAsync<MeResult>(HttpMethod.Get, "/api/mobile/me", null, ct);

    public Task<DashboardSummary> GetDashboardSummaryAsync(CancellationToken ct = default) =>
        SendAsync<DashboardSummary>(HttpMethod.Get, "/api/mobile/dashboard_summary", null, ct);

    public void Dispose() => _http.Dispose();
}
