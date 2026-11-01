using System.Net;
using Udc.Client;
using Xunit;

namespace Udc.Client.Tests;

public class ApiClientTests
{
    [Fact]
    public async Task LoginAsync_UnwrapsTheDataEnvelope()
    {
        var body = """
        {"success":true,"data":{"token":"abc123","expires_at":"2026-12-01 00:00:00",
         "user":{"id":1,"username":"admin","full_name":"Admin","email":null,"role_id":1,
                 "role_name":"Super Admin","store_id":null,"permissions":["dashboard.view"]}}}
        """;
        var handler = new FakeHttpMessageHandler(HttpStatusCode.OK, body);
        using var client = new ApiClient("http://127.0.0.1:3100", handler);

        var result = await client.LoginAsync("admin", "pw", "test-device");

        Assert.Equal("abc123", result.Token);
        Assert.Equal("admin", result.User.Username);
        Assert.Equal("Super Admin", result.User.RoleName);
        Assert.Contains("dashboard.view", result.User.Permissions);
        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal("/api/mobile/login", handler.LastRequest.RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task LoginAsync_WrongPassword_ThrowsWithTheServersCodeAndMessage()
    {
        var body = """{"success":false,"error":{"code":"authentication_failed","message":"Invalid username or password."}}""";
        using var client = new ApiClient("http://127.0.0.1:3100", new FakeHttpMessageHandler(HttpStatusCode.Unauthorized, body));

        var ex = await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("admin", "wrong", "test-device"));

        Assert.Equal("authentication_failed", ex.Code);
        Assert.Equal("Invalid username or password.", ex.Message);
    }

    [Fact]
    public async Task GetMeAsync_SendsTheBearerToken()
    {
        var body = """
        {"success":true,"data":{"user":{"id":1,"username":"admin","full_name":"Admin","email":null,"role_id":1,"role_name":"Super Admin"},
         "store":{"fixed_store":null,"requires_store_selection":true,"available_stores":[]},"permissions":["dashboard.view"]}}
        """;
        var handler = new FakeHttpMessageHandler(HttpStatusCode.OK, body);
        using var client = new ApiClient("http://127.0.0.1:3100", handler) { BearerToken = "tok-xyz" };

        var result = await client.GetMeAsync();

        Assert.True(result.Store.RequiresStoreSelection);
        Assert.Equal("Bearer", handler.LastRequest!.Headers.Authorization!.Scheme);
        Assert.Equal("tok-xyz", handler.LastRequest.Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task GetDashboardSummaryAsync_ParsesCardsAndSeries()
    {
        var body = """
        {"success":true,"data":{"date":"2026-11-01","store_scoped":false,
          "cards":{"todays_orders":5,"pending_orders":2,"processing":1,"qc_pending":0,"rework":0,
                   "ready":1,"packed":0,"out_for_delivery":0,"delivered_today":3,
                   "todays_sales":1250.50,"todays_collection":900,"outstanding":350.5,
                   "pickup_pending":0,"delivery_pending":1},
          "sales_7_days":[{"date":"2026-10-26","label":"26 Oct","total":500}],
          "orders_by_status":[{"label":"Received","color":"#000","count":2}],
          "payments_by_mode_30_days":[{"label":"Cash","total":900}],
          "top_garments_30_days":[{"name":"Shirt","qty":10}],
          "top_customers_90_days":[{"id":1,"name":"Asha","mobile":"9000000000","total":1200}]}}
        """;
        using var client = new ApiClient("http://127.0.0.1:3100", new FakeHttpMessageHandler(HttpStatusCode.OK, body));

        var summary = await client.GetDashboardSummaryAsync();

        Assert.Equal(5, summary.Cards.TodaysOrders);
        Assert.Equal(1250.50m, summary.Cards.TodaysSales);
        Assert.Single(summary.Sales7Days);
        Assert.Equal("26 Oct", summary.Sales7Days[0].Label);
        Assert.Single(summary.TopCustomers90Days);
        Assert.Equal("Asha", summary.TopCustomers90Days[0].Name);
    }
}
