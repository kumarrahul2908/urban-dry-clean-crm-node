using System.Text.Json.Serialization;

namespace Udc.Client.Models;

/// <summary>Wire format used by every <c>/api/mobile/*</c> response: <c>{"success":true,"data":...}</c>
/// or <c>{"success":false,"error":{"code","message"}}</c> (see src/lib/http.ts `ok()` / `ApiError`).</summary>
public sealed class ApiEnvelope<T>
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("data")]
    public T? Data { get; set; }

    [JsonPropertyName("error")]
    public ApiErrorPayload? Error { get; set; }
}

public sealed class ApiErrorPayload
{
    [JsonPropertyName("code")]
    public string Code { get; set; } = "";

    [JsonPropertyName("message")]
    public string Message { get; set; } = "";
}
