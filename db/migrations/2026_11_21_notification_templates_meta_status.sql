-- Templates created from the CRM/app are submitted to Meta automatically; we track their review status here.
ALTER TABLE notification_templates
  ADD COLUMN meta_status VARCHAR(20) NULL,
  ADD COLUMN meta_template_id VARCHAR(40) NULL,
  ADD COLUMN meta_reject_reason VARCHAR(255) NULL,
  ADD COLUMN category VARCHAR(20) NULL;
