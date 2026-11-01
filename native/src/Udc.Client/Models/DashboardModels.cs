using System.Text.Json.Serialization;

namespace Udc.Client.Models;

/// <summary>Maps <c>GET /api/mobile/dashboard_summary</c> (see src/routes/mobile/reports.ts).</summary>
public sealed class DashboardSummary
{
    [JsonPropertyName("date")]
    public string Date { get; set; } = "";

    [JsonPropertyName("store_scoped")]
    public bool StoreScoped { get; set; }

    [JsonPropertyName("cards")]
    public DashboardCards Cards { get; set; } = new();

    [JsonPropertyName("sales_7_days")]
    public List<DailyTotal> Sales7Days { get; set; } = new();

    [JsonPropertyName("orders_by_status")]
    public List<StatusCount> OrdersByStatus { get; set; } = new();

    [JsonPropertyName("payments_by_mode_30_days")]
    public List<LabeledTotal> PaymentsByMode30Days { get; set; } = new();

    [JsonPropertyName("top_garments_30_days")]
    public List<GarmentQty> TopGarments30Days { get; set; } = new();

    [JsonPropertyName("top_customers_90_days")]
    public List<CustomerTotal> TopCustomers90Days { get; set; } = new();
}

public sealed class DashboardCards
{
    [JsonPropertyName("todays_orders")]
    public int TodaysOrders { get; set; }

    [JsonPropertyName("pending_orders")]
    public int PendingOrders { get; set; }

    [JsonPropertyName("processing")]
    public int Processing { get; set; }

    [JsonPropertyName("qc_pending")]
    public int QcPending { get; set; }

    [JsonPropertyName("rework")]
    public int Rework { get; set; }

    [JsonPropertyName("ready")]
    public int Ready { get; set; }

    [JsonPropertyName("packed")]
    public int Packed { get; set; }

    [JsonPropertyName("out_for_delivery")]
    public int OutForDelivery { get; set; }

    [JsonPropertyName("delivered_today")]
    public int DeliveredToday { get; set; }

    [JsonPropertyName("todays_sales")]
    public decimal TodaysSales { get; set; }

    [JsonPropertyName("todays_collection")]
    public decimal TodaysCollection { get; set; }

    [JsonPropertyName("outstanding")]
    public decimal Outstanding { get; set; }

    [JsonPropertyName("pickup_pending")]
    public int PickupPending { get; set; }

    [JsonPropertyName("delivery_pending")]
    public int DeliveryPending { get; set; }
}

public sealed class DailyTotal
{
    [JsonPropertyName("date")]
    public string Date { get; set; } = "";

    [JsonPropertyName("label")]
    public string Label { get; set; } = "";

    [JsonPropertyName("total")]
    public decimal Total { get; set; }
}

public sealed class StatusCount
{
    [JsonPropertyName("label")]
    public string Label { get; set; } = "";

    [JsonPropertyName("color")]
    public string? Color { get; set; }

    [JsonPropertyName("count")]
    public int Count { get; set; }
}

public sealed class LabeledTotal
{
    [JsonPropertyName("label")]
    public string Label { get; set; } = "";

    [JsonPropertyName("total")]
    public decimal Total { get; set; }
}

public sealed class GarmentQty
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("qty")]
    public int Qty { get; set; }
}

public sealed class CustomerTotal
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("mobile")]
    public string? Mobile { get; set; }

    [JsonPropertyName("total")]
    public decimal Total { get; set; }
}
