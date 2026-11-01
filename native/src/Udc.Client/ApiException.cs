namespace Udc.Client;

/// <summary>Thrown when the backend returns <c>{"success":false,...}</c>, or the HTTP call itself
/// fails (connection refused, timeout, etc. - <see cref="Code"/> is <c>"network_error"</c> then).</summary>
public sealed class ApiException : Exception
{
    public string Code { get; }

    public ApiException(string code, string message) : base(message)
    {
        Code = code;
    }

    public ApiException(string code, string message, Exception inner) : base(message, inner)
    {
        Code = code;
    }
}
