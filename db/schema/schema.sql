-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1:3306
-- Generation Time: Oct 10, 2026 at 04:55 AM
-- Server version: 11.8.9-MariaDB-log
-- PHP Version: 7.2.34

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `u179541647_testudc`
--

-- --------------------------------------------------------

--
-- Table structure for table `accounts_receivable`
--

CREATE TABLE `accounts_receivable` (
  `id` int(10) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `invoice_number` varchar(30) DEFAULT NULL,
  `total_amount` decimal(12,2) NOT NULL,
  `paid_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `due_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `status` enum('Open','Cancelled','Refund Due') NOT NULL DEFAULT 'Open',
  `due_date` date DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `accounts_receivable`
--


-- --------------------------------------------------------

--
-- Table structure for table `api_tokens`
--

CREATE TABLE `api_tokens` (
  `id` int(10) UNSIGNED NOT NULL,
  `user_id` int(10) UNSIGNED NOT NULL,
  `token_hash` char(64) NOT NULL,
  `device_name` varchar(150) DEFAULT NULL,
  `device_id` varchar(150) DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `last_used_at` datetime DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `api_tokens`
--


-- --------------------------------------------------------

--
-- Table structure for table `audit_logs`
--

CREATE TABLE `audit_logs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `user_id` int(10) UNSIGNED DEFAULT NULL,
  `action` varchar(60) NOT NULL,
  `module` varchar(60) NOT NULL,
  `record_id` varchar(30) DEFAULT NULL,
  `old_value` text DEFAULT NULL,
  `new_value` text DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `audit_logs`
--


-- --------------------------------------------------------

--
-- Table structure for table `barcodes`
--

CREATE TABLE `barcodes` (
  `id` int(10) UNSIGNED NOT NULL,
  `barcode_value` varchar(60) NOT NULL,
  `qr_token` char(32) NOT NULL,
  `short_qr_payload` varchar(20) DEFAULT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `laundry_garment_id` int(10) UNSIGNED DEFAULT NULL,
  `item_sequence` int(10) UNSIGNED NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `barcodes`
--


-- --------------------------------------------------------

--
-- Table structure for table `brands`
--

CREATE TABLE `brands` (
  `id` int(10) UNSIGNED NOT NULL,
  `brand_name` varchar(100) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `brands`
--


-- --------------------------------------------------------

--
-- Table structure for table `categories`
--

CREATE TABLE `categories` (
  `id` int(10) UNSIGNED NOT NULL,
  `category_name` varchar(100) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `categories`
--


-- --------------------------------------------------------

--
-- Table structure for table `colors`
--

CREATE TABLE `colors` (
  `id` int(10) UNSIGNED NOT NULL,
  `color_name` varchar(50) NOT NULL,
  `hex_code` varchar(7) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `colors`
--


-- --------------------------------------------------------

--
-- Table structure for table `customers`
--

CREATE TABLE `customers` (
  `id` int(10) UNSIGNED NOT NULL,
  `customer_code` varchar(30) NOT NULL,
  `title` varchar(10) DEFAULT NULL,
  `full_name` varchar(120) NOT NULL,
  `address` varchar(255) DEFAULT NULL,
  `area` varchar(100) DEFAULT NULL,
  `city` varchar(100) DEFAULT NULL,
  `state` varchar(100) DEFAULT NULL,
  `pincode` varchar(12) DEFAULT NULL,
  `mobile` varchar(20) NOT NULL,
  `alt_mobile` varchar(20) DEFAULT NULL,
  `email` varchar(120) DEFAULT NULL,
  `membership_id` varchar(50) DEFAULT NULL,
  `barcode` varchar(60) DEFAULT NULL,
  `birthday` date DEFAULT NULL,
  `anniversary` date DEFAULT NULL,
  `remarks` text DEFAULT NULL,
  `home_delivery` tinyint(1) NOT NULL DEFAULT 0,
  `marketing_source` varchar(100) DEFAULT NULL,
  `registration_source` varchar(50) DEFAULT 'Counter',
  `discount_percent` decimal(5,2) NOT NULL DEFAULT 0.00,
  `price_list_id` int(10) UNSIGNED DEFAULT NULL,
  `communication_preference` varchar(20) DEFAULT 'SMS',
  `gstin` varchar(20) DEFAULT NULL,
  `referral_code` varchar(30) DEFAULT NULL,
  `referred_by_customer_id` int(10) UNSIGNED DEFAULT NULL,
  `otp` varchar(64) DEFAULT NULL,
  `otp_expires` datetime DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `customers`
--


-- --------------------------------------------------------

--
-- Table structure for table `customer_addresses`
--

CREATE TABLE `customer_addresses` (
  `id` int(10) UNSIGNED NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `label` varchar(50) DEFAULT 'Home',
  `address` varchar(255) NOT NULL,
  `area` varchar(100) DEFAULT NULL,
  `city` varchar(100) DEFAULT NULL,
  `state` varchar(100) DEFAULT NULL,
  `pincode` varchar(12) DEFAULT NULL,
  `landmark` varchar(150) DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `customer_wallet`
--

CREATE TABLE `customer_wallet` (
  `customer_id` int(10) UNSIGNED NOT NULL,
  `balance` decimal(12,2) NOT NULL DEFAULT 0.00,
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `customer_wallet`
--


-- --------------------------------------------------------

--
-- Table structure for table `defects`
--

CREATE TABLE `defects` (
  `id` int(10) UNSIGNED NOT NULL,
  `defect_name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `defects`
--


-- --------------------------------------------------------

--
-- Table structure for table `delivery_orders`
--

CREATE TABLE `delivery_orders` (
  `id` int(10) UNSIGNED NOT NULL,
  `delivery_number` varchar(30) NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `address` varchar(255) DEFAULT NULL,
  `amount_due` decimal(12,2) NOT NULL DEFAULT 0.00,
  `delivery_date` date NOT NULL,
  `time_slot` varchar(30) DEFAULT NULL,
  `driver_id` int(10) UNSIGNED DEFAULT NULL,
  `status` enum('Pending','Assigned','Out for Delivery','Delivered','Cancelled') NOT NULL DEFAULT 'Pending',
  `otp` varchar(10) DEFAULT NULL,
  `signature_data` text DEFAULT NULL,
  `payment_collected` decimal(12,2) NOT NULL DEFAULT 0.00,
  `remarks` varchar(255) DEFAULT NULL,
  `delivered_at` datetime DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `discounts`
--

CREATE TABLE `discounts` (
  `id` int(10) UNSIGNED NOT NULL,
  `discount_name` varchar(100) NOT NULL,
  `discount_type` enum('Percent','Flat') NOT NULL DEFAULT 'Percent',
  `discount_value` decimal(10,2) NOT NULL DEFAULT 0.00,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `discounts`
--


-- --------------------------------------------------------

--
-- Table structure for table `drivers`
--

CREATE TABLE `drivers` (
  `id` int(10) UNSIGNED NOT NULL,
  `driver_name` varchar(100) NOT NULL,
  `driver_code` varchar(30) DEFAULT NULL,
  `mobile` varchar(20) DEFAULT NULL,
  `vehicle_number` varchar(30) DEFAULT NULL,
  `area_assigned` varchar(150) DEFAULT NULL,
  `user_id` int(10) UNSIGNED DEFAULT NULL,
  `status` enum('Available','On Duty','Off Duty') NOT NULL DEFAULT 'Available',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `drivers`
--


-- --------------------------------------------------------

--
-- Table structure for table `expenses`
--

CREATE TABLE `expenses` (
  `id` int(10) UNSIGNED NOT NULL,
  `expense_date` date NOT NULL,
  `category_id` int(10) UNSIGNED NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `amount` decimal(12,2) NOT NULL,
  `payment_mode` varchar(30) DEFAULT NULL,
  `vendor` varchar(120) DEFAULT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `attachment` varchar(255) DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `expense_categories`
--

CREATE TABLE `expense_categories` (
  `id` int(10) UNSIGNED NOT NULL,
  `category_name` varchar(100) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `expense_categories`
--


-- --------------------------------------------------------

--
-- Table structure for table `feedback`
--

CREATE TABLE `feedback` (
  `id` int(10) UNSIGNED NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `rating` tinyint(3) UNSIGNED NOT NULL,
  `comments` text DEFAULT NULL,
  `status` enum('New','Reviewed','Resolved') NOT NULL DEFAULT 'New',
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `garments`
--

CREATE TABLE `garments` (
  `id` int(10) UNSIGNED NOT NULL,
  `garment_name` varchar(100) NOT NULL,
  `sku` varchar(50) DEFAULT NULL,
  `category_id` int(10) UNSIGNED NOT NULL,
  `default_service_id` int(10) UNSIGNED DEFAULT NULL,
  `unit` varchar(20) NOT NULL DEFAULT 'Pcs',
  `image` varchar(255) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `garments`
--


-- --------------------------------------------------------

--
-- Table structure for table `garment_status_history`
--

CREATE TABLE `garment_status_history` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `laundry_garment_id` int(10) UNSIGNED DEFAULT NULL,
  `previous_status` varchar(30) DEFAULT NULL,
  `new_status` varchar(30) NOT NULL,
  `changed_by` int(10) UNSIGNED DEFAULT NULL,
  `changed_at` datetime NOT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `module` varchar(40) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `garment_status_history`
--


-- --------------------------------------------------------

--
-- Table structure for table `garment_tags`
--

CREATE TABLE `garment_tags` (
  `id` int(10) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `laundry_garment_id` int(10) UNSIGNED DEFAULT NULL,
  `barcode_id` int(10) UNSIGNED NOT NULL,
  `printed_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `last_printed_at` datetime DEFAULT NULL,
  `last_printed_by` int(10) UNSIGNED DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `garment_tags`
--


-- --------------------------------------------------------

--
-- Table structure for table `income`
--

CREATE TABLE `income` (
  `id` int(10) UNSIGNED NOT NULL,
  `income_date` date NOT NULL,
  `source` varchar(120) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `amount` decimal(12,2) NOT NULL,
  `payment_mode` varchar(30) DEFAULT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `laundry_garments`
--

CREATE TABLE `laundry_garments` (
  `id` int(10) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED NOT NULL,
  `garment_id` int(10) UNSIGNED NOT NULL,
  `sequence` int(10) UNSIGNED NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `laundry_garments`
--


-- --------------------------------------------------------

--
-- Table structure for table `login_ip_attempts`
--

CREATE TABLE `login_ip_attempts` (
  `ip_address` varchar(45) NOT NULL,
  `window_start` datetime NOT NULL,
  `failed_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `blocked_until` datetime DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `login_ip_attempts`
--


-- --------------------------------------------------------

--
-- Table structure for table `notification_logs`
--

CREATE TABLE `notification_logs` (
  `id` int(10) UNSIGNED NOT NULL,
  `customer_id` int(10) UNSIGNED DEFAULT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `user_id` int(10) UNSIGNED DEFAULT NULL,
  `template_key` varchar(60) DEFAULT NULL,
  `channel` varchar(20) DEFAULT NULL,
  `recipient` varchar(120) DEFAULT NULL,
  `message` text DEFAULT NULL,
  `status` enum('Queued','Sent','Failed') NOT NULL DEFAULT 'Queued',
  `error_message` varchar(255) DEFAULT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `read_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `provider` varchar(20) DEFAULT NULL,
  `provider_message_id` varchar(100) DEFAULT NULL,
  `direction` enum('Outbound','Inbound') DEFAULT 'Outbound'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `notification_logs`
--


-- --------------------------------------------------------

--
-- Table structure for table `notification_templates`
--

CREATE TABLE `notification_templates` (
  `id` int(10) UNSIGNED NOT NULL,
  `template_key` varchar(60) NOT NULL,
  `channel` enum('SMS','WhatsApp','Email') NOT NULL,
  `subject` varchar(150) DEFAULT NULL,
  `body` text NOT NULL,
  `provider_template_name` varchar(150) DEFAULT NULL,
  `language` varchar(10) DEFAULT NULL,
  `template_param_order` text DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `notification_templates`
--


-- --------------------------------------------------------

--
-- Table structure for table `orders`
--

CREATE TABLE `orders` (
  `id` int(10) UNSIGNED NOT NULL,
  `order_number` varchar(30) NOT NULL,
  `short_order_code` varchar(10) DEFAULT NULL,
  `invoice_number` varchar(30) DEFAULT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `store_id` int(10) UNSIGNED DEFAULT NULL,
  `order_mode` enum('piece','weight') NOT NULL DEFAULT 'piece',
  `price_list_id` int(10) UNSIGNED NOT NULL,
  `order_date` datetime NOT NULL,
  `due_date` date NOT NULL,
  `due_time` time DEFAULT NULL,
  `urgent_level_id` int(10) UNSIGNED DEFAULT NULL,
  `packaging_preference` enum('HANGER','FOLD') DEFAULT NULL,
  `home_delivery` tinyint(1) NOT NULL DEFAULT 0,
  `notes` text DEFAULT NULL,
  `workshop_notes` text DEFAULT NULL,
  `subtotal` decimal(12,2) NOT NULL DEFAULT 0.00,
  `discount_type` enum('Percent','Flat') DEFAULT 'Percent',
  `discount_value` decimal(10,2) NOT NULL DEFAULT 0.00,
  `discount_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `urgent_charge` decimal(12,2) NOT NULL DEFAULT 0.00,
  `tax_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `delivery_charge` decimal(12,2) NOT NULL DEFAULT 0.00,
  `grand_total` decimal(12,2) NOT NULL DEFAULT 0.00,
  `advance_paid` decimal(12,2) NOT NULL DEFAULT 0.00,
  `total_paid` decimal(12,2) NOT NULL DEFAULT 0.00,
  `current_due` decimal(12,2) NOT NULL DEFAULT 0.00,
  `status_id` int(10) UNSIGNED NOT NULL,
  `order_type` varchar(30) DEFAULT 'Counter',
  `client_request_id` varchar(64) DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `updated_by` int(10) UNSIGNED DEFAULT NULL,
  `cancelled_at` datetime DEFAULT NULL,
  `cancelled_by` int(10) UNSIGNED DEFAULT NULL,
  `cancelled_reason` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `orders`
--


-- --------------------------------------------------------

--
-- Table structure for table `order_items`
--

CREATE TABLE `order_items` (
  `id` int(10) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `garment_id` int(10) UNSIGNED DEFAULT NULL,
  `service_id` int(10) UNSIGNED NOT NULL,
  `quantity` decimal(8,2) NOT NULL DEFAULT 1.00,
  `unit` varchar(20) NOT NULL DEFAULT 'Pcs',
  `unit_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `weight` decimal(8,3) DEFAULT NULL,
  `weight_rate` decimal(10,2) DEFAULT NULL,
  `is_manual_override` tinyint(1) NOT NULL DEFAULT 0,
  `subtotal` decimal(12,2) NOT NULL DEFAULT 0.00,
  `discount` decimal(10,2) NOT NULL DEFAULT 0.00,
  `tax_percent` decimal(5,2) NOT NULL DEFAULT 0.00,
  `tax` decimal(10,2) NOT NULL DEFAULT 0.00,
  `total` decimal(12,2) NOT NULL DEFAULT 0.00,
  `brand_id` int(10) UNSIGNED DEFAULT NULL,
  `color_id` int(10) UNSIGNED DEFAULT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `client_request_id` varchar(64) DEFAULT NULL,
  `inspection_notes` varchar(255) DEFAULT NULL,
  `item_status` enum('Pending','Workshop','Processing','QC','Rework','Ready','Packed','Delivered','Damaged','Missing') NOT NULL DEFAULT 'Pending',
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `order_items`
--


-- --------------------------------------------------------

--
-- Table structure for table `order_item_defects`
--

CREATE TABLE `order_item_defects` (
  `order_item_id` int(10) UNSIGNED NOT NULL,
  `defect_id` int(10) UNSIGNED NOT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `recorded_by` int(10) UNSIGNED DEFAULT NULL,
  `recorded_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `order_item_defects`
--


-- --------------------------------------------------------

--
-- Table structure for table `order_photos`
--

CREATE TABLE `order_photos` (
  `id` int(10) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `file_path` varchar(255) NOT NULL,
  `caption` varchar(255) DEFAULT NULL,
  `uploaded_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `order_statuses`
--

CREATE TABLE `order_statuses` (
  `id` int(10) UNSIGNED NOT NULL,
  `status_key` varchar(40) NOT NULL,
  `status_label` varchar(60) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `color` varchar(20) DEFAULT '#6c757d'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `order_statuses`
--


-- --------------------------------------------------------

--
-- Table structure for table `organizations`
--

CREATE TABLE `organizations` (
  `id` int(10) UNSIGNED NOT NULL,
  `org_name` varchar(150) NOT NULL,
  `org_code` varchar(30) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `organizations`
--


-- --------------------------------------------------------

--
-- Table structure for table `packing`
--

CREATE TABLE `packing` (
  `id` int(10) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `package_number` int(10) UNSIGNED NOT NULL,
  `total_packages` int(10) UNSIGNED NOT NULL,
  `garment_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `status` enum('Created','Printed') NOT NULL DEFAULT 'Created',
  `barcode_value` varchar(60) NOT NULL,
  `qr_token` char(32) NOT NULL,
  `printed_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `last_printed_at` datetime DEFAULT NULL,
  `last_printed_by` int(10) UNSIGNED DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `packing`
--


-- --------------------------------------------------------

--
-- Table structure for table `payments`
--

CREATE TABLE `payments` (
  `id` int(10) UNSIGNED NOT NULL,
  `payment_number` varchar(30) NOT NULL,
  `client_request_id` varchar(64) DEFAULT NULL,
  `request_fingerprint` char(64) DEFAULT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `payment_date` datetime NOT NULL,
  `total_amount` decimal(12,2) NOT NULL,
  `payment_kind` enum('Full','Partial','Advance','Refund') NOT NULL DEFAULT 'Full',
  `remarks` varchar(255) DEFAULT NULL,
  `approved_by` int(10) UNSIGNED DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `payments`
--


-- --------------------------------------------------------

--
-- Table structure for table `payment_transactions`
--

CREATE TABLE `payment_transactions` (
  `id` int(10) UNSIGNED NOT NULL,
  `payment_id` int(10) UNSIGNED NOT NULL,
  `payment_type_id` int(10) UNSIGNED NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `reference_no` varchar(60) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `payment_transactions`
--


-- --------------------------------------------------------

--
-- Table structure for table `payment_types`
--

CREATE TABLE `payment_types` (
  `id` int(10) UNSIGNED NOT NULL,
  `type_name` varchar(50) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `payment_types`
--


-- --------------------------------------------------------

--
-- Table structure for table `permissions`
--

CREATE TABLE `permissions` (
  `id` int(10) UNSIGNED NOT NULL,
  `permission_key` varchar(100) NOT NULL,
  `module` varchar(50) NOT NULL,
  `description` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `permissions`
--


-- --------------------------------------------------------

--
-- Table structure for table `pickup_orders`
--

CREATE TABLE `pickup_orders` (
  `id` int(10) UNSIGNED NOT NULL,
  `pickup_number` varchar(30) NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `address` varchar(255) NOT NULL,
  `area` varchar(100) DEFAULT NULL,
  `pincode` varchar(12) DEFAULT NULL,
  `pickup_date` date NOT NULL,
  `pickup_time` varchar(30) DEFAULT NULL,
  `garment_count` int(10) UNSIGNED DEFAULT NULL,
  `notes` varchar(255) DEFAULT NULL,
  `driver_id` int(10) UNSIGNED DEFAULT NULL,
  `status` enum('Requested','Scheduled','Assigned','Picked Up','Cancelled','Completed') NOT NULL DEFAULT 'Requested',
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `price_lists`
--

CREATE TABLE `price_lists` (
  `id` int(10) UNSIGNED NOT NULL,
  `price_list_name` varchar(100) NOT NULL,
  `list_type` enum('Default','Customer','Membership') NOT NULL DEFAULT 'Default',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `price_lists`
--


-- --------------------------------------------------------

--
-- Table structure for table `price_list_items`
--

CREATE TABLE `price_list_items` (
  `id` int(10) UNSIGNED NOT NULL,
  `price_list_id` int(10) UNSIGNED NOT NULL,
  `garment_id` int(10) UNSIGNED NOT NULL,
  `service_id` int(10) UNSIGNED NOT NULL,
  `piece_rate` decimal(10,2) NOT NULL DEFAULT 0.00,
  `weight_rate` decimal(10,2) DEFAULT NULL,
  `min_weight_charge` decimal(10,2) DEFAULT NULL,
  `tax_id` int(10) UNSIGNED DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `price_list_items`
--


-- --------------------------------------------------------

--
-- Table structure for table `price_list_service_rates`
--

CREATE TABLE `price_list_service_rates` (
  `id` int(10) UNSIGNED NOT NULL,
  `price_list_id` int(10) UNSIGNED NOT NULL,
  `service_id` int(10) UNSIGNED NOT NULL,
  `weight_rate` decimal(10,2) NOT NULL DEFAULT 0.00,
  `min_weight_charge` decimal(10,2) DEFAULT NULL,
  `tax_id` int(10) UNSIGNED DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `price_list_service_rates`
--


-- --------------------------------------------------------

--
-- Table structure for table `printers`
--

CREATE TABLE `printers` (
  `id` int(10) UNSIGNED NOT NULL,
  `printer_name` varchar(100) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

--
-- Dumping data for table `printers`
--


-- --------------------------------------------------------

--
-- Table structure for table `qc_records`
--

CREATE TABLE `qc_records` (
  `id` int(10) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `laundry_garment_id` int(10) UNSIGNED DEFAULT NULL,
  `checked_by` int(10) UNSIGNED DEFAULT NULL,
  `result` enum('Passed','Failed','Rework','Damaged','Missing','Customer Inspection Required') NOT NULL,
  `reason` varchar(255) DEFAULT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `checked_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `rework_records`
--

CREATE TABLE `rework_records` (
  `id` int(10) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `laundry_garment_id` int(10) UNSIGNED DEFAULT NULL,
  `qc_record_id` int(10) UNSIGNED DEFAULT NULL,
  `reason` varchar(255) DEFAULT NULL,
  `rework_date` date DEFAULT NULL,
  `workshop_id` int(10) UNSIGNED DEFAULT NULL,
  `status` enum('Pending','In Progress','Completed') NOT NULL DEFAULT 'Pending',
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `roles`
--

CREATE TABLE `roles` (
  `id` int(10) UNSIGNED NOT NULL,
  `role_name` varchar(50) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_system` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `roles`
--


-- --------------------------------------------------------

--
-- Table structure for table `role_permissions`
--

CREATE TABLE `role_permissions` (
  `role_id` int(10) UNSIGNED NOT NULL,
  `permission_id` int(10) UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `role_permissions`
--


-- --------------------------------------------------------

--
-- Table structure for table `services`
--

CREATE TABLE `services` (
  `id` int(10) UNSIGNED NOT NULL,
  `service_name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `billing_unit` enum('piece','weight') NOT NULL DEFAULT 'piece',
  `pricing_scope` enum('garment','universal') NOT NULL DEFAULT 'garment',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `services`
--


-- --------------------------------------------------------

--
-- Table structure for table `settings`
--

CREATE TABLE `settings` (
  `setting_key` varchar(80) NOT NULL,
  `setting_value` text DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `settings`
--


-- --------------------------------------------------------

--
-- Table structure for table `stores`
--

CREATE TABLE `stores` (
  `id` int(10) UNSIGNED NOT NULL,
  `organization_id` int(10) UNSIGNED NOT NULL DEFAULT 1,
  `store_name` varchar(100) NOT NULL,
  `store_type` enum('main','branch') NOT NULL DEFAULT 'branch',
  `address` varchar(255) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `stores`
--


-- --------------------------------------------------------

--
-- Table structure for table `store_print_settings`
--

CREATE TABLE `store_print_settings` (
  `id` int(10) UNSIGNED NOT NULL,
  `store_id` int(10) UNSIGNED NOT NULL,
  `tag_width_mm` decimal(6,2) NOT NULL DEFAULT 38.10,
  `tag_height_mm` decimal(6,2) NOT NULL DEFAULT 78.74,
  `tag_unit` enum('in','mm') NOT NULL DEFAULT 'in',
  `tag_printer_name` varchar(100) DEFAULT NULL,
  `invoice_printer_type` enum('thermal','laser') NOT NULL DEFAULT 'laser',
  `invoice_width_mm` decimal(6,2) NOT NULL DEFAULT 210.00,
  `invoice_height_mm` decimal(6,2) DEFAULT 297.00,
  `invoice_paper_size` varchar(20) NOT NULL DEFAULT 'a4',
  `invoice_unit` enum('in','mm') NOT NULL DEFAULT 'mm',
  `invoice_printer_name` varchar(100) DEFAULT NULL,
  `delivery_printer_type` enum('thermal','laser') DEFAULT NULL,
  `delivery_width_mm` decimal(6,2) DEFAULT NULL,
  `delivery_height_mm` decimal(6,2) DEFAULT NULL,
  `delivery_paper_size` varchar(20) DEFAULT NULL,
  `delivery_unit` enum('in','mm') DEFAULT NULL,
  `delivery_printer_name` varchar(100) DEFAULT NULL,
  `local_print_token` varchar(64) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

--
-- Dumping data for table `store_print_settings`
--


-- --------------------------------------------------------

--
-- Table structure for table `taxes`
--

CREATE TABLE `taxes` (
  `id` int(10) UNSIGNED NOT NULL,
  `tax_name` varchar(50) NOT NULL,
  `tax_percent` decimal(5,2) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `taxes`
--


-- --------------------------------------------------------

--
-- Table structure for table `urgent_levels`
--

CREATE TABLE `urgent_levels` (
  `id` int(10) UNSIGNED NOT NULL,
  `level_name` varchar(50) NOT NULL,
  `surcharge_percent` decimal(5,2) NOT NULL DEFAULT 0.00,
  `day_offset` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `turnaround_hours` int(10) UNSIGNED DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `urgent_levels`
--


-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int(10) UNSIGNED NOT NULL,
  `role_id` int(10) UNSIGNED NOT NULL,
  `employee_code` varchar(30) DEFAULT NULL,
  `full_name` varchar(100) NOT NULL,
  `username` varchar(50) NOT NULL,
  `email` varchar(100) DEFAULT NULL,
  `mobile` varchar(20) DEFAULT NULL,
  `password_hash` varchar(255) NOT NULL,
  `store_id` int(10) UNSIGNED DEFAULT NULL,
  `workshop_id` int(10) UNSIGNED DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `last_login_at` datetime DEFAULT NULL,
  `last_login_ip` varchar(45) DEFAULT NULL,
  `failed_login_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `locked_until` datetime DEFAULT NULL,
  `reset_token` varchar(255) DEFAULT NULL,
  `reset_token_expires` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `users`
--


-- --------------------------------------------------------

--
-- Table structure for table `user_sessions`
--

CREATE TABLE `user_sessions` (
  `id` varchar(128) NOT NULL,
  `user_id` int(10) UNSIGNED NOT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` varchar(255) DEFAULT NULL,
  `last_activity` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `wallet_transactions`
--

CREATE TABLE `wallet_transactions` (
  `id` int(10) UNSIGNED NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `txn_type` enum('Deposit','Redeem','Refund','Adjustment') NOT NULL,
  `debit` decimal(12,2) NOT NULL DEFAULT 0.00,
  `credit` decimal(12,2) NOT NULL DEFAULT 0.00,
  `balance_after` decimal(12,2) NOT NULL,
  `payment_mode` varchar(30) DEFAULT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `client_request_id` varchar(64) DEFAULT NULL,
  `request_fingerprint` char(64) DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `whatsapp_accounts`
--

CREATE TABLE `whatsapp_accounts` (
  `id` int(10) UNSIGNED NOT NULL,
  `store_id` int(10) UNSIGNED DEFAULT NULL,
  `account_name` varchar(100) NOT NULL,
  `provider` varchar(20) NOT NULL DEFAULT 'meta',
  `waba_id` varchar(60) NOT NULL,
  `phone_number_id` varchar(60) NOT NULL,
  `sender_display_number` varchar(20) DEFAULT NULL,
  `access_token_encrypted` text NOT NULL,
  `app_id` varchar(60) DEFAULT NULL,
  `app_secret_encrypted` text DEFAULT NULL,
  `webhook_verify_token` varchar(100) DEFAULT NULL,
  `api_version` varchar(10) NOT NULL DEFAULT 'v21.0',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `whatsapp_accounts`
--


-- --------------------------------------------------------

--
-- Table structure for table `whatsapp_campaigns`
--

CREATE TABLE `whatsapp_campaigns` (
  `id` int(10) UNSIGNED NOT NULL,
  `campaign_name` varchar(150) NOT NULL,
  `segment_key` varchar(60) NOT NULL,
  `template_id` int(10) UNSIGNED NOT NULL,
  `store_id` int(10) UNSIGNED DEFAULT NULL,
  `account_id` int(10) UNSIGNED NOT NULL,
  `status` enum('Draft','Sending','Completed','Cancelled') NOT NULL DEFAULT 'Draft',
  `recipient_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `whatsapp_marketing_rules`
--

CREATE TABLE `whatsapp_marketing_rules` (
  `id` int(10) UNSIGNED NOT NULL,
  `rule_name` varchar(150) NOT NULL,
  `segment_key` varchar(60) NOT NULL,
  `template_id` int(10) UNSIGNED NOT NULL,
  `store_id` int(10) UNSIGNED DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 0,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `whatsapp_outbound_queue`
--

CREATE TABLE `whatsapp_outbound_queue` (
  `id` int(10) UNSIGNED NOT NULL,
  `account_id` int(10) UNSIGNED DEFAULT NULL,
  `customer_id` int(10) UNSIGNED DEFAULT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `to_number` varchar(20) NOT NULL,
  `message_type` enum('template','text','media') NOT NULL DEFAULT 'template',
  `template_key` varchar(60) DEFAULT NULL,
  `payload_json` text NOT NULL,
  `event_ref` varchar(150) DEFAULT NULL,
  `campaign_id` int(10) UNSIGNED DEFAULT NULL,
  `status` enum('Queued','Sending','Sent','Delivered','Read','Failed','Cancelled') NOT NULL DEFAULT 'Queued',
  `retry_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `max_retries` int(10) UNSIGNED NOT NULL DEFAULT 3,
  `next_attempt_at` datetime DEFAULT NULL,
  `provider_message_id` varchar(100) DEFAULT NULL,
  `error_message` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `sent_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `whatsapp_outbound_queue`
--


-- --------------------------------------------------------

--
-- Table structure for table `workshops`
--

CREATE TABLE `workshops` (
  `id` int(10) UNSIGNED NOT NULL,
  `workshop_name` varchar(100) NOT NULL,
  `address` varchar(255) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `commission_workshop_percent` decimal(5,2) NOT NULL DEFAULT 50.00,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `company_name` varchar(150) DEFAULT NULL,
  `gstin` varchar(20) DEFAULT NULL,
  `email` varchar(120) DEFAULT NULL,
  `state_code` char(2) DEFAULT NULL,
  `invoice_prefix` varchar(10) DEFAULT NULL,
  `invoice_next_number` int(10) UNSIGNED NOT NULL DEFAULT 1,
  `payment_terms_days` smallint(5) UNSIGNED NOT NULL DEFAULT 0,
  `item_description` varchar(120) NOT NULL DEFAULT 'Dry Clean charges',
  `invoice_notes` text DEFAULT NULL,
  `bank_details` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `workshops`
--


-- --------------------------------------------------------

--
-- Table structure for table `workshop_bills`
--

CREATE TABLE `workshop_bills` (
  `id` int(10) UNSIGNED NOT NULL,
  `bill_number` varchar(30) NOT NULL,
  `store_id` int(10) UNSIGNED DEFAULT NULL,
  `is_combined` tinyint(1) NOT NULL DEFAULT 0,
  `billing_basis` enum('whole','sent_only') NOT NULL DEFAULT 'sent_only',
  `workshop_id` int(10) UNSIGNED NOT NULL,
  `period_start` date NOT NULL,
  `period_end` date NOT NULL,
  `invoice_date` date DEFAULT NULL,
  `due_date` date DEFAULT NULL,
  `terms_label` varchar(40) DEFAULT NULL,
  `subject` varchar(150) DEFAULT NULL,
  `item_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `total_value` decimal(12,2) NOT NULL DEFAULT 0.00,
  `share_percent` decimal(5,2) NOT NULL DEFAULT 50.00,
  `gst_mode` enum('none','inclusive','exclusive') NOT NULL DEFAULT 'none',
  `gst_rate` decimal(5,2) NOT NULL DEFAULT 18.00,
  `gst_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `workshop_share` decimal(12,2) NOT NULL DEFAULT 0.00,
  `store_share` decimal(12,2) NOT NULL DEFAULT 0.00,
  `grand_total` decimal(12,2) NOT NULL DEFAULT 0.00,
  `amount_paid` decimal(12,2) NOT NULL DEFAULT 0.00,
  `status` enum('Unpaid','Partially Paid','Paid','Void') NOT NULL DEFAULT 'Unpaid',
  `payment_type_id` int(10) UNSIGNED DEFAULT NULL,
  `reference_no` varchar(100) DEFAULT NULL,
  `paid_at` datetime DEFAULT NULL,
  `paid_by` int(10) UNSIGNED DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `snapshot_json` mediumtext DEFAULT NULL,
  `voided_at` datetime DEFAULT NULL,
  `voided_by` int(10) UNSIGNED DEFAULT NULL,
  `void_reason` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `workshop_bills`
--


-- --------------------------------------------------------

--
-- Table structure for table `workshop_bill_items`
--

CREATE TABLE `workshop_bill_items` (
  `id` int(10) UNSIGNED NOT NULL,
  `bill_id` int(10) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED NOT NULL,
  `item_value` decimal(10,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `workshop_bill_items`
--


-- --------------------------------------------------------

--
-- Table structure for table `workshop_bill_payments`
--

CREATE TABLE `workshop_bill_payments` (
  `id` int(10) UNSIGNED NOT NULL,
  `bill_id` int(10) UNSIGNED NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `payment_type_id` int(10) UNSIGNED NOT NULL,
  `reference_no` varchar(100) DEFAULT NULL,
  `paid_on` date NOT NULL,
  `notes` varchar(255) DEFAULT NULL,
  `received_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workshop_challans`
--

CREATE TABLE `workshop_challans` (
  `id` int(10) UNSIGNED NOT NULL,
  `challan_number` varchar(30) NOT NULL,
  `workshop_id` int(10) UNSIGNED NOT NULL,
  `challan_date` datetime NOT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `created_by` int(10) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `workshop_challans`
--


-- --------------------------------------------------------

--
-- Table structure for table `workshop_items`
--

CREATE TABLE `workshop_items` (
  `id` int(10) UNSIGNED NOT NULL,
  `challan_id` int(10) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `laundry_garment_id` int(10) UNSIGNED DEFAULT NULL,
  `status` enum('Pending','Sent','Received','Processing','Completed','Rejected','Rework') NOT NULL DEFAULT 'Sent',
  `sent_at` datetime DEFAULT NULL,
  `received_at` datetime DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `remarks` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `workshop_items`
--


--
-- Indexes for dumped tables
--

--
-- Indexes for table `accounts_receivable`
--
ALTER TABLE `accounts_receivable`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `order_id` (`order_id`),
  ADD KEY `customer_id` (`customer_id`);

--
-- Indexes for table `api_tokens`
--
ALTER TABLE `api_tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_token_hash` (`token_hash`),
  ADD KEY `idx_api_tokens_user` (`user_id`),
  ADD KEY `idx_api_tokens_expires` (`expires_at`),
  ADD KEY `idx_api_tokens_revoked` (`revoked_at`);

--
-- Indexes for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`user_id`),
  ADD KEY `idx_audit_module` (`module`),
  ADD KEY `idx_audit_date` (`created_at`);

--
-- Indexes for table `barcodes`
--
ALTER TABLE `barcodes`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `barcode_value` (`barcode_value`),
  ADD UNIQUE KEY `qr_token` (`qr_token`),
  ADD UNIQUE KEY `order_item_id` (`order_item_id`),
  ADD UNIQUE KEY `laundry_garment_id` (`laundry_garment_id`),
  ADD UNIQUE KEY `idx_barcodes_short_qr_payload` (`short_qr_payload`),
  ADD KEY `order_id` (`order_id`),
  ADD KEY `idx_barcode_value` (`barcode_value`),
  ADD KEY `idx_qr_token` (`qr_token`);

--
-- Indexes for table `brands`
--
ALTER TABLE `brands`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `brand_name` (`brand_name`);

--
-- Indexes for table `categories`
--
ALTER TABLE `categories`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `category_name` (`category_name`);

--
-- Indexes for table `colors`
--
ALTER TABLE `colors`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `color_name` (`color_name`);

--
-- Indexes for table `customers`
--
ALTER TABLE `customers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `customer_code` (`customer_code`),
  ADD UNIQUE KEY `barcode` (`barcode`),
  ADD KEY `idx_customers_mobile` (`mobile`),
  ADD KEY `idx_customers_name` (`full_name`),
  ADD KEY `idx_customers_barcode` (`barcode`),
  ADD KEY `created_by` (`created_by`),
  ADD KEY `fk_customers_pricelist` (`price_list_id`);

--
-- Indexes for table `customer_addresses`
--
ALTER TABLE `customer_addresses`
  ADD PRIMARY KEY (`id`),
  ADD KEY `customer_id` (`customer_id`);

--
-- Indexes for table `customer_wallet`
--
ALTER TABLE `customer_wallet`
  ADD PRIMARY KEY (`customer_id`);

--
-- Indexes for table `defects`
--
ALTER TABLE `defects`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `defect_name` (`defect_name`);

--
-- Indexes for table `delivery_orders`
--
ALTER TABLE `delivery_orders`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `delivery_number` (`delivery_number`),
  ADD KEY `order_id` (`order_id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `driver_id` (`driver_id`),
  ADD KEY `created_by` (`created_by`);

--
-- Indexes for table `discounts`
--
ALTER TABLE `discounts`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `drivers`
--
ALTER TABLE `drivers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `driver_code` (`driver_code`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `expenses`
--
ALTER TABLE `expenses`
  ADD PRIMARY KEY (`id`),
  ADD KEY `category_id` (`category_id`),
  ADD KEY `created_by` (`created_by`);

--
-- Indexes for table `expense_categories`
--
ALTER TABLE `expense_categories`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `category_name` (`category_name`);

--
-- Indexes for table `feedback`
--
ALTER TABLE `feedback`
  ADD PRIMARY KEY (`id`),
  ADD KEY `customer_id` (`customer_id`);

--
-- Indexes for table `garments`
--
ALTER TABLE `garments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_garment_name_category` (`garment_name`,`category_id`),
  ADD UNIQUE KEY `sku` (`sku`),
  ADD KEY `category_id` (`category_id`),
  ADD KEY `default_service_id` (`default_service_id`),
  ADD KEY `idx_garments_name` (`garment_name`);

--
-- Indexes for table `garment_status_history`
--
ALTER TABLE `garment_status_history`
  ADD PRIMARY KEY (`id`),
  ADD KEY `changed_by` (`changed_by`),
  ADD KEY `idx_gsh_item` (`order_item_id`),
  ADD KEY `idx_gsh_laundry_garment` (`laundry_garment_id`),
  ADD KEY `idx_gsh_date` (`changed_at`);

--
-- Indexes for table `garment_tags`
--
ALTER TABLE `garment_tags`
  ADD PRIMARY KEY (`id`),
  ADD KEY `order_item_id` (`order_item_id`),
  ADD KEY `laundry_garment_id` (`laundry_garment_id`),
  ADD KEY `barcode_id` (`barcode_id`),
  ADD KEY `last_printed_by` (`last_printed_by`);

--
-- Indexes for table `income`
--
ALTER TABLE `income`
  ADD PRIMARY KEY (`id`),
  ADD KEY `created_by` (`created_by`);

--
-- Indexes for table `laundry_garments`
--
ALTER TABLE `laundry_garments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_batch_sequence` (`order_item_id`,`sequence`),
  ADD KEY `garment_id` (`garment_id`);

--
-- Indexes for table `login_ip_attempts`
--
ALTER TABLE `login_ip_attempts`
  ADD PRIMARY KEY (`ip_address`),
  ADD KEY `idx_login_ip_attempts_updated` (`updated_at`);

--
-- Indexes for table `notification_logs`
--
ALTER TABLE `notification_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `order_id` (`order_id`),
  ADD KEY `user_id` (`user_id`),
  ADD KEY `idx_provider_message_id` (`provider_message_id`);

--
-- Indexes for table `notification_templates`
--
ALTER TABLE `notification_templates`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_template_key_channel` (`template_key`,`channel`);

--
-- Indexes for table `orders`
--
ALTER TABLE `orders`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `order_number` (`order_number`),
  ADD UNIQUE KEY `invoice_number` (`invoice_number`),
  ADD UNIQUE KEY `idx_orders_client_request_id` (`client_request_id`),
  ADD UNIQUE KEY `idx_orders_short_order_code` (`short_order_code`),
  ADD KEY `store_id` (`store_id`),
  ADD KEY `price_list_id` (`price_list_id`),
  ADD KEY `urgent_level_id` (`urgent_level_id`),
  ADD KEY `created_by` (`created_by`),
  ADD KEY `updated_by` (`updated_by`),
  ADD KEY `cancelled_by` (`cancelled_by`),
  ADD KEY `idx_orders_date` (`order_date`),
  ADD KEY `idx_orders_status` (`status_id`),
  ADD KEY `idx_orders_customer` (`customer_id`);

--
-- Indexes for table `order_items`
--
ALTER TABLE `order_items`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_order_items_client_request` (`order_id`,`client_request_id`),
  ADD KEY `order_id` (`order_id`),
  ADD KEY `garment_id` (`garment_id`),
  ADD KEY `service_id` (`service_id`),
  ADD KEY `brand_id` (`brand_id`),
  ADD KEY `color_id` (`color_id`);

--
-- Indexes for table `order_item_defects`
--
ALTER TABLE `order_item_defects`
  ADD PRIMARY KEY (`order_item_id`,`defect_id`),
  ADD KEY `defect_id` (`defect_id`),
  ADD KEY `recorded_by` (`recorded_by`);

--
-- Indexes for table `order_photos`
--
ALTER TABLE `order_photos`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_order_photos_user` (`uploaded_by`),
  ADD KEY `idx_order_photos_order` (`order_id`),
  ADD KEY `idx_order_photos_item` (`order_item_id`);

--
-- Indexes for table `order_statuses`
--
ALTER TABLE `order_statuses`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `status_key` (`status_key`);

--
-- Indexes for table `organizations`
--
ALTER TABLE `organizations`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `org_code` (`org_code`);

--
-- Indexes for table `packing`
--
ALTER TABLE `packing`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `barcode_value` (`barcode_value`),
  ADD UNIQUE KEY `qr_token` (`qr_token`),
  ADD UNIQUE KEY `uq_order_package` (`order_id`,`package_number`),
  ADD KEY `last_printed_by` (`last_printed_by`),
  ADD KEY `created_by` (`created_by`),
  ADD KEY `idx_packing_barcode` (`barcode_value`),
  ADD KEY `idx_packing_qr` (`qr_token`);

--
-- Indexes for table `payments`
--
ALTER TABLE `payments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `payment_number` (`payment_number`),
  ADD UNIQUE KEY `idx_payments_client_request_id` (`client_request_id`),
  ADD KEY `order_id` (`order_id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `approved_by` (`approved_by`),
  ADD KEY `created_by` (`created_by`);

--
-- Indexes for table `payment_transactions`
--
ALTER TABLE `payment_transactions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `payment_id` (`payment_id`),
  ADD KEY `payment_type_id` (`payment_type_id`);

--
-- Indexes for table `payment_types`
--
ALTER TABLE `payment_types`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `type_name` (`type_name`);

--
-- Indexes for table `permissions`
--
ALTER TABLE `permissions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `permission_key` (`permission_key`);

--
-- Indexes for table `pickup_orders`
--
ALTER TABLE `pickup_orders`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `pickup_number` (`pickup_number`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `order_id` (`order_id`),
  ADD KEY `driver_id` (`driver_id`),
  ADD KEY `created_by` (`created_by`);

--
-- Indexes for table `price_lists`
--
ALTER TABLE `price_lists`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `price_list_items`
--
ALTER TABLE `price_list_items`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_price_item` (`price_list_id`,`garment_id`,`service_id`),
  ADD KEY `garment_id` (`garment_id`),
  ADD KEY `service_id` (`service_id`),
  ADD KEY `tax_id` (`tax_id`);

--
-- Indexes for table `price_list_service_rates`
--
ALTER TABLE `price_list_service_rates`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_service_rate` (`price_list_id`,`service_id`),
  ADD KEY `service_id` (`service_id`),
  ADD KEY `tax_id` (`tax_id`);

--
-- Indexes for table `printers`
--
ALTER TABLE `printers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_printers_name` (`printer_name`);

--
-- Indexes for table `qc_records`
--
ALTER TABLE `qc_records`
  ADD PRIMARY KEY (`id`),
  ADD KEY `order_item_id` (`order_item_id`),
  ADD KEY `checked_by` (`checked_by`),
  ADD KEY `idx_qc_records_laundry_garment` (`laundry_garment_id`);

--
-- Indexes for table `rework_records`
--
ALTER TABLE `rework_records`
  ADD PRIMARY KEY (`id`),
  ADD KEY `order_item_id` (`order_item_id`),
  ADD KEY `qc_record_id` (`qc_record_id`),
  ADD KEY `workshop_id` (`workshop_id`),
  ADD KEY `idx_rework_records_laundry_garment` (`laundry_garment_id`);

--
-- Indexes for table `roles`
--
ALTER TABLE `roles`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `role_name` (`role_name`);

--
-- Indexes for table `role_permissions`
--
ALTER TABLE `role_permissions`
  ADD PRIMARY KEY (`role_id`,`permission_id`),
  ADD KEY `permission_id` (`permission_id`);

--
-- Indexes for table `services`
--
ALTER TABLE `services`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `service_name` (`service_name`);

--
-- Indexes for table `settings`
--
ALTER TABLE `settings`
  ADD PRIMARY KEY (`setting_key`);

--
-- Indexes for table `stores`
--
ALTER TABLE `stores`
  ADD PRIMARY KEY (`id`),
  ADD KEY `organization_id` (`organization_id`);

--
-- Indexes for table `store_print_settings`
--
ALTER TABLE `store_print_settings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_store_print_settings_store` (`store_id`);

--
-- Indexes for table `taxes`
--
ALTER TABLE `taxes`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `urgent_levels`
--
ALTER TABLE `urgent_levels`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `level_name` (`level_name`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`),
  ADD UNIQUE KEY `employee_code` (`employee_code`),
  ADD UNIQUE KEY `email` (`email`),
  ADD KEY `role_id` (`role_id`),
  ADD KEY `fk_users_store` (`store_id`),
  ADD KEY `fk_users_workshop` (`workshop_id`);

--
-- Indexes for table `user_sessions`
--
ALTER TABLE `user_sessions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `wallet_transactions`
--
ALTER TABLE `wallet_transactions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_wallet_transactions_client_request_id` (`client_request_id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `created_by` (`created_by`);

--
-- Indexes for table `whatsapp_accounts`
--
ALTER TABLE `whatsapp_accounts`
  ADD PRIMARY KEY (`id`),
  ADD KEY `store_id` (`store_id`);

--
-- Indexes for table `whatsapp_campaigns`
--
ALTER TABLE `whatsapp_campaigns`
  ADD PRIMARY KEY (`id`),
  ADD KEY `template_id` (`template_id`),
  ADD KEY `store_id` (`store_id`),
  ADD KEY `account_id` (`account_id`),
  ADD KEY `created_by` (`created_by`);

--
-- Indexes for table `whatsapp_marketing_rules`
--
ALTER TABLE `whatsapp_marketing_rules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `template_id` (`template_id`),
  ADD KEY `store_id` (`store_id`);

--
-- Indexes for table `whatsapp_outbound_queue`
--
ALTER TABLE `whatsapp_outbound_queue`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_event_ref` (`event_ref`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_provider_message_id` (`provider_message_id`),
  ADD KEY `account_id` (`account_id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `order_id` (`order_id`);

--
-- Indexes for table `workshops`
--
ALTER TABLE `workshops`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_invoice_prefix` (`invoice_prefix`);

--
-- Indexes for table `workshop_bills`
--
ALTER TABLE `workshop_bills`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `bill_number` (`bill_number`),
  ADD KEY `fk_wb_paytype` (`payment_type_id`),
  ADD KEY `fk_wb_created_by` (`created_by`),
  ADD KEY `fk_wb_paid_by` (`paid_by`),
  ADD KEY `idx_wb_store` (`store_id`),
  ADD KEY `idx_wb_workshop` (`workshop_id`),
  ADD KEY `idx_wb_period` (`period_start`,`period_end`);

--
-- Indexes for table `workshop_bill_items`
--
ALTER TABLE `workshop_bill_items`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_wbi_item` (`order_item_id`),
  ADD KEY `fk_wbi_bill` (`bill_id`);

--
-- Indexes for table `workshop_bill_payments`
--
ALTER TABLE `workshop_bill_payments`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_wbp_type` (`payment_type_id`),
  ADD KEY `fk_wbp_user` (`received_by`),
  ADD KEY `idx_wbp_bill` (`bill_id`);

--
-- Indexes for table `workshop_challans`
--
ALTER TABLE `workshop_challans`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `challan_number` (`challan_number`),
  ADD KEY `workshop_id` (`workshop_id`),
  ADD KEY `created_by` (`created_by`);

--
-- Indexes for table `workshop_items`
--
ALTER TABLE `workshop_items`
  ADD PRIMARY KEY (`id`),
  ADD KEY `challan_id` (`challan_id`),
  ADD KEY `order_item_id` (`order_item_id`),
  ADD KEY `idx_workshop_items_laundry_garment` (`laundry_garment_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `accounts_receivable`
--
ALTER TABLE `accounts_receivable`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=93;

--
-- AUTO_INCREMENT for table `api_tokens`
--
ALTER TABLE `api_tokens`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=242;

--
-- AUTO_INCREMENT for table `audit_logs`
--
ALTER TABLE `audit_logs`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1638;

--
-- AUTO_INCREMENT for table `barcodes`
--
ALTER TABLE `barcodes`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=131;

--
-- AUTO_INCREMENT for table `brands`
--
ALTER TABLE `brands`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `categories`
--
ALTER TABLE `categories`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;

--
-- AUTO_INCREMENT for table `colors`
--
ALTER TABLE `colors`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- AUTO_INCREMENT for table `customers`
--
ALTER TABLE `customers`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=69;

--
-- AUTO_INCREMENT for table `customer_addresses`
--
ALTER TABLE `customer_addresses`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `defects`
--
ALTER TABLE `defects`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;

--
-- AUTO_INCREMENT for table `delivery_orders`
--
ALTER TABLE `delivery_orders`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=14;

--
-- AUTO_INCREMENT for table `discounts`
--
ALTER TABLE `discounts`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `drivers`
--
ALTER TABLE `drivers`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=12;

--
-- AUTO_INCREMENT for table `expenses`
--
ALTER TABLE `expenses`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `expense_categories`
--
ALTER TABLE `expense_categories`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=10;

--
-- AUTO_INCREMENT for table `feedback`
--
ALTER TABLE `feedback`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `garments`
--
ALTER TABLE `garments`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=131;

--
-- AUTO_INCREMENT for table `garment_status_history`
--
ALTER TABLE `garment_status_history`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=88;

--
-- AUTO_INCREMENT for table `garment_tags`
--
ALTER TABLE `garment_tags`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=131;

--
-- AUTO_INCREMENT for table `income`
--
ALTER TABLE `income`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `laundry_garments`
--
ALTER TABLE `laundry_garments`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=11;

--
-- AUTO_INCREMENT for table `notification_logs`
--
ALTER TABLE `notification_logs`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=210;

--
-- AUTO_INCREMENT for table `notification_templates`
--
ALTER TABLE `notification_templates`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=15;

--
-- AUTO_INCREMENT for table `orders`
--
ALTER TABLE `orders`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=116;

--
-- AUTO_INCREMENT for table `order_items`
--
ALTER TABLE `order_items`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=137;

--
-- AUTO_INCREMENT for table `order_photos`
--
ALTER TABLE `order_photos`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `order_statuses`
--
ALTER TABLE `order_statuses`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=12;

--
-- AUTO_INCREMENT for table `organizations`
--
ALTER TABLE `organizations`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `packing`
--
ALTER TABLE `packing`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `payments`
--
ALTER TABLE `payments`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=25;

--
-- AUTO_INCREMENT for table `payment_transactions`
--
ALTER TABLE `payment_transactions`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=25;

--
-- AUTO_INCREMENT for table `payment_types`
--
ALTER TABLE `payment_types`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;

--
-- AUTO_INCREMENT for table `permissions`
--
ALTER TABLE `permissions`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=56;

--
-- AUTO_INCREMENT for table `pickup_orders`
--
ALTER TABLE `pickup_orders`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `price_lists`
--
ALTER TABLE `price_lists`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `price_list_items`
--
ALTER TABLE `price_list_items`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1122;

--
-- AUTO_INCREMENT for table `price_list_service_rates`
--
ALTER TABLE `price_list_service_rates`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `printers`
--
ALTER TABLE `printers`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `qc_records`
--
ALTER TABLE `qc_records`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `rework_records`
--
ALTER TABLE `rework_records`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `roles`
--
ALTER TABLE `roles`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- AUTO_INCREMENT for table `services`
--
ALTER TABLE `services`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- AUTO_INCREMENT for table `stores`
--
ALTER TABLE `stores`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- AUTO_INCREMENT for table `store_print_settings`
--
ALTER TABLE `store_print_settings`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=10;

--
-- AUTO_INCREMENT for table `taxes`
--
ALTER TABLE `taxes`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `urgent_levels`
--
ALTER TABLE `urgent_levels`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=112;

--
-- AUTO_INCREMENT for table `wallet_transactions`
--
ALTER TABLE `wallet_transactions`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=18;

--
-- AUTO_INCREMENT for table `whatsapp_accounts`
--
ALTER TABLE `whatsapp_accounts`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `whatsapp_campaigns`
--
ALTER TABLE `whatsapp_campaigns`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `whatsapp_marketing_rules`
--
ALTER TABLE `whatsapp_marketing_rules`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `whatsapp_outbound_queue`
--
ALTER TABLE `whatsapp_outbound_queue`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=55;

--
-- AUTO_INCREMENT for table `workshops`
--
ALTER TABLE `workshops`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `workshop_bills`
--
ALTER TABLE `workshop_bills`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=17;

--
-- AUTO_INCREMENT for table `workshop_bill_items`
--
ALTER TABLE `workshop_bill_items`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=63;

--
-- AUTO_INCREMENT for table `workshop_bill_payments`
--
ALTER TABLE `workshop_bill_payments`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `workshop_challans`
--
ALTER TABLE `workshop_challans`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=17;

--
-- AUTO_INCREMENT for table `workshop_items`
--
ALTER TABLE `workshop_items`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=31;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `accounts_receivable`
--
ALTER TABLE `accounts_receivable`
  ADD CONSTRAINT `accounts_receivable_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `accounts_receivable_ibfk_2` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`);

--
-- Constraints for table `api_tokens`
--
ALTER TABLE `api_tokens`
  ADD CONSTRAINT `fk_api_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD CONSTRAINT `audit_logs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);

--
-- Constraints for table `barcodes`
--
ALTER TABLE `barcodes`
  ADD CONSTRAINT `barcodes_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `barcodes_ibfk_2` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `barcodes_ibfk_3` FOREIGN KEY (`laundry_garment_id`) REFERENCES `laundry_garments` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `customers`
--
ALTER TABLE `customers`
  ADD CONSTRAINT `customers_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  ADD CONSTRAINT `fk_customers_pricelist` FOREIGN KEY (`price_list_id`) REFERENCES `price_lists` (`id`);

--
-- Constraints for table `customer_addresses`
--
ALTER TABLE `customer_addresses`
  ADD CONSTRAINT `customer_addresses_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `customer_wallet`
--
ALTER TABLE `customer_wallet`
  ADD CONSTRAINT `customer_wallet_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `delivery_orders`
--
ALTER TABLE `delivery_orders`
  ADD CONSTRAINT `delivery_orders_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`),
  ADD CONSTRAINT `delivery_orders_ibfk_2` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  ADD CONSTRAINT `delivery_orders_ibfk_3` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`),
  ADD CONSTRAINT `delivery_orders_ibfk_4` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `drivers`
--
ALTER TABLE `drivers`
  ADD CONSTRAINT `drivers_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);

--
-- Constraints for table `expenses`
--
ALTER TABLE `expenses`
  ADD CONSTRAINT `expenses_ibfk_1` FOREIGN KEY (`category_id`) REFERENCES `expense_categories` (`id`),
  ADD CONSTRAINT `expenses_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `feedback`
--
ALTER TABLE `feedback`
  ADD CONSTRAINT `feedback_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `garments`
--
ALTER TABLE `garments`
  ADD CONSTRAINT `garments_ibfk_1` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`),
  ADD CONSTRAINT `garments_ibfk_2` FOREIGN KEY (`default_service_id`) REFERENCES `services` (`id`);

--
-- Constraints for table `garment_status_history`
--
ALTER TABLE `garment_status_history`
  ADD CONSTRAINT `garment_status_history_ibfk_1` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `garment_status_history_ibfk_2` FOREIGN KEY (`laundry_garment_id`) REFERENCES `laundry_garments` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `garment_status_history_ibfk_3` FOREIGN KEY (`changed_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `garment_tags`
--
ALTER TABLE `garment_tags`
  ADD CONSTRAINT `garment_tags_ibfk_1` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `garment_tags_ibfk_2` FOREIGN KEY (`laundry_garment_id`) REFERENCES `laundry_garments` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `garment_tags_ibfk_3` FOREIGN KEY (`barcode_id`) REFERENCES `barcodes` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `garment_tags_ibfk_4` FOREIGN KEY (`last_printed_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `income`
--
ALTER TABLE `income`
  ADD CONSTRAINT `income_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `laundry_garments`
--
ALTER TABLE `laundry_garments`
  ADD CONSTRAINT `laundry_garments_ibfk_1` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `laundry_garments_ibfk_2` FOREIGN KEY (`garment_id`) REFERENCES `garments` (`id`);

--
-- Constraints for table `notification_logs`
--
ALTER TABLE `notification_logs`
  ADD CONSTRAINT `notification_logs_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  ADD CONSTRAINT `notification_logs_ibfk_2` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`),
  ADD CONSTRAINT `notification_logs_ibfk_3` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);

--
-- Constraints for table `orders`
--
ALTER TABLE `orders`
  ADD CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  ADD CONSTRAINT `orders_ibfk_2` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`),
  ADD CONSTRAINT `orders_ibfk_3` FOREIGN KEY (`price_list_id`) REFERENCES `price_lists` (`id`),
  ADD CONSTRAINT `orders_ibfk_4` FOREIGN KEY (`urgent_level_id`) REFERENCES `urgent_levels` (`id`),
  ADD CONSTRAINT `orders_ibfk_5` FOREIGN KEY (`status_id`) REFERENCES `order_statuses` (`id`),
  ADD CONSTRAINT `orders_ibfk_6` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  ADD CONSTRAINT `orders_ibfk_7` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`),
  ADD CONSTRAINT `orders_ibfk_8` FOREIGN KEY (`cancelled_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `order_items`
--
ALTER TABLE `order_items`
  ADD CONSTRAINT `order_items_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `order_items_ibfk_2` FOREIGN KEY (`garment_id`) REFERENCES `garments` (`id`),
  ADD CONSTRAINT `order_items_ibfk_3` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`),
  ADD CONSTRAINT `order_items_ibfk_4` FOREIGN KEY (`brand_id`) REFERENCES `brands` (`id`),
  ADD CONSTRAINT `order_items_ibfk_5` FOREIGN KEY (`color_id`) REFERENCES `colors` (`id`);

--
-- Constraints for table `order_item_defects`
--
ALTER TABLE `order_item_defects`
  ADD CONSTRAINT `order_item_defects_ibfk_1` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `order_item_defects_ibfk_2` FOREIGN KEY (`defect_id`) REFERENCES `defects` (`id`),
  ADD CONSTRAINT `order_item_defects_ibfk_3` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `order_photos`
--
ALTER TABLE `order_photos`
  ADD CONSTRAINT `fk_order_photos_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_order_photos_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_order_photos_user` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `packing`
--
ALTER TABLE `packing`
  ADD CONSTRAINT `packing_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `packing_ibfk_2` FOREIGN KEY (`last_printed_by`) REFERENCES `users` (`id`),
  ADD CONSTRAINT `packing_ibfk_3` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `payments`
--
ALTER TABLE `payments`
  ADD CONSTRAINT `payments_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`),
  ADD CONSTRAINT `payments_ibfk_2` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  ADD CONSTRAINT `payments_ibfk_3` FOREIGN KEY (`approved_by`) REFERENCES `users` (`id`),
  ADD CONSTRAINT `payments_ibfk_4` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `payment_transactions`
--
ALTER TABLE `payment_transactions`
  ADD CONSTRAINT `payment_transactions_ibfk_1` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `payment_transactions_ibfk_2` FOREIGN KEY (`payment_type_id`) REFERENCES `payment_types` (`id`);

--
-- Constraints for table `pickup_orders`
--
ALTER TABLE `pickup_orders`
  ADD CONSTRAINT `pickup_orders_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  ADD CONSTRAINT `pickup_orders_ibfk_2` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`),
  ADD CONSTRAINT `pickup_orders_ibfk_3` FOREIGN KEY (`driver_id`) REFERENCES `drivers` (`id`),
  ADD CONSTRAINT `pickup_orders_ibfk_4` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `price_list_items`
--
ALTER TABLE `price_list_items`
  ADD CONSTRAINT `price_list_items_ibfk_1` FOREIGN KEY (`price_list_id`) REFERENCES `price_lists` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `price_list_items_ibfk_2` FOREIGN KEY (`garment_id`) REFERENCES `garments` (`id`),
  ADD CONSTRAINT `price_list_items_ibfk_3` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`),
  ADD CONSTRAINT `price_list_items_ibfk_4` FOREIGN KEY (`tax_id`) REFERENCES `taxes` (`id`);

--
-- Constraints for table `price_list_service_rates`
--
ALTER TABLE `price_list_service_rates`
  ADD CONSTRAINT `price_list_service_rates_ibfk_1` FOREIGN KEY (`price_list_id`) REFERENCES `price_lists` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `price_list_service_rates_ibfk_2` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`),
  ADD CONSTRAINT `price_list_service_rates_ibfk_3` FOREIGN KEY (`tax_id`) REFERENCES `taxes` (`id`);

--
-- Constraints for table `qc_records`
--
ALTER TABLE `qc_records`
  ADD CONSTRAINT `qc_records_ibfk_1` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `qc_records_ibfk_2` FOREIGN KEY (`laundry_garment_id`) REFERENCES `laundry_garments` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `qc_records_ibfk_3` FOREIGN KEY (`checked_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `rework_records`
--
ALTER TABLE `rework_records`
  ADD CONSTRAINT `rework_records_ibfk_1` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `rework_records_ibfk_2` FOREIGN KEY (`laundry_garment_id`) REFERENCES `laundry_garments` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `rework_records_ibfk_3` FOREIGN KEY (`qc_record_id`) REFERENCES `qc_records` (`id`),
  ADD CONSTRAINT `rework_records_ibfk_4` FOREIGN KEY (`workshop_id`) REFERENCES `workshops` (`id`);

--
-- Constraints for table `role_permissions`
--
ALTER TABLE `role_permissions`
  ADD CONSTRAINT `role_permissions_ibfk_1` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `role_permissions_ibfk_2` FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `stores`
--
ALTER TABLE `stores`
  ADD CONSTRAINT `stores_ibfk_1` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`);

--
-- Constraints for table `store_print_settings`
--
ALTER TABLE `store_print_settings`
  ADD CONSTRAINT `fk_store_print_settings_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `users`
--
ALTER TABLE `users`
  ADD CONSTRAINT `fk_users_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`),
  ADD CONSTRAINT `fk_users_workshop` FOREIGN KEY (`workshop_id`) REFERENCES `workshops` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `users_ibfk_1` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`);

--
-- Constraints for table `user_sessions`
--
ALTER TABLE `user_sessions`
  ADD CONSTRAINT `user_sessions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `wallet_transactions`
--
ALTER TABLE `wallet_transactions`
  ADD CONSTRAINT `wallet_transactions_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  ADD CONSTRAINT `wallet_transactions_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `whatsapp_accounts`
--
ALTER TABLE `whatsapp_accounts`
  ADD CONSTRAINT `whatsapp_accounts_ibfk_1` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`);

--
-- Constraints for table `whatsapp_campaigns`
--
ALTER TABLE `whatsapp_campaigns`
  ADD CONSTRAINT `whatsapp_campaigns_ibfk_1` FOREIGN KEY (`template_id`) REFERENCES `notification_templates` (`id`),
  ADD CONSTRAINT `whatsapp_campaigns_ibfk_2` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`),
  ADD CONSTRAINT `whatsapp_campaigns_ibfk_3` FOREIGN KEY (`account_id`) REFERENCES `whatsapp_accounts` (`id`),
  ADD CONSTRAINT `whatsapp_campaigns_ibfk_4` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `whatsapp_marketing_rules`
--
ALTER TABLE `whatsapp_marketing_rules`
  ADD CONSTRAINT `whatsapp_marketing_rules_ibfk_1` FOREIGN KEY (`template_id`) REFERENCES `notification_templates` (`id`),
  ADD CONSTRAINT `whatsapp_marketing_rules_ibfk_2` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`);

--
-- Constraints for table `whatsapp_outbound_queue`
--
ALTER TABLE `whatsapp_outbound_queue`
  ADD CONSTRAINT `whatsapp_outbound_queue_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `whatsapp_accounts` (`id`),
  ADD CONSTRAINT `whatsapp_outbound_queue_ibfk_2` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  ADD CONSTRAINT `whatsapp_outbound_queue_ibfk_3` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`);

--
-- Constraints for table `workshop_bills`
--
ALTER TABLE `workshop_bills`
  ADD CONSTRAINT `fk_wb_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_wb_paid_by` FOREIGN KEY (`paid_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_wb_paytype` FOREIGN KEY (`payment_type_id`) REFERENCES `payment_types` (`id`),
  ADD CONSTRAINT `fk_wb_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`),
  ADD CONSTRAINT `fk_wb_workshop` FOREIGN KEY (`workshop_id`) REFERENCES `workshops` (`id`);

--
-- Constraints for table `workshop_bill_items`
--
ALTER TABLE `workshop_bill_items`
  ADD CONSTRAINT `fk_wbi_bill` FOREIGN KEY (`bill_id`) REFERENCES `workshop_bills` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_wbi_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`);

--
-- Constraints for table `workshop_bill_payments`
--
ALTER TABLE `workshop_bill_payments`
  ADD CONSTRAINT `fk_wbp_bill` FOREIGN KEY (`bill_id`) REFERENCES `workshop_bills` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_wbp_type` FOREIGN KEY (`payment_type_id`) REFERENCES `payment_types` (`id`),
  ADD CONSTRAINT `fk_wbp_user` FOREIGN KEY (`received_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `workshop_challans`
--
ALTER TABLE `workshop_challans`
  ADD CONSTRAINT `workshop_challans_ibfk_1` FOREIGN KEY (`workshop_id`) REFERENCES `workshops` (`id`),
  ADD CONSTRAINT `workshop_challans_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `workshop_items`
--
ALTER TABLE `workshop_items`
  ADD CONSTRAINT `workshop_items_ibfk_1` FOREIGN KEY (`challan_id`) REFERENCES `workshop_challans` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `workshop_items_ibfk_2` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `workshop_items_ibfk_3` FOREIGN KEY (`laundry_garment_id`) REFERENCES `laundry_garments` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
