import type { IntegrationManifest } from './types.js';

type ManifestSeed = Omit<IntegrationManifest, 'version' | 'nodeConfig' | 'builtin' | 'runtime'> & {
  runtime?: IntegrationManifest['runtime'];
};

const bearerCredential = { type: 'bearer_token', fields: ['token'] };
const oauthCredential = { type: 'oauth2', fields: ['access_token'] };
const apiKeyCredential = { type: 'api_key', fields: ['apiKey', 'headerName'] };
const jiraCredential = { type: 'api_key', fields: ['siteUrl', 'email', 'apiToken'] };
const supabaseCredential = { type: 'api_key', fields: ['projectUrl', 'apiKey'] };
const trelloCredential = { type: 'api_key', fields: ['apiKey', 'token'] };
const twilioCredential = { type: 'api_key', fields: ['accountSid', 'authToken'] };
const wordpressCredential = { type: 'api_key', fields: ['siteUrl', 'username', 'applicationPassword'] };
const zendeskCredential = { type: 'api_key', fields: ['subdomain', 'email', 'apiToken'] };
const noCredential = { type: 'none', fields: [] };

const seeds: ManifestSeed[] = [
  manifest('http_request', 'HTTP Request', 'Core', 'Raw HTTP request with flexible auth and response parsing.', ['request'], noCredential, 'https://developer.mozilla.org/docs/Web/API/fetch', 'implemented'),
  manifest('webhook_send', 'Webhook Send', 'Core', 'Send signed outbound webhook payloads.', ['send'], { type: 'shared_secret', fields: ['secret'] }, undefined, 'implemented'),
  manifest('slack', 'Slack', 'Communication', 'Post messages and reactions to Slack workspaces.', ['send_message', 'add_reaction'], bearerCredential, 'https://api.slack.com/methods', 'implemented'),
  manifest('gmail', 'Gmail', 'Communication', 'Send Gmail messages through the Google API.', ['send_email'], oauthCredential, 'https://developers.google.com/gmail/api/reference/rest', 'implemented'),
  manifest('agentmail', 'AgentMail', 'Communication', 'Email built for agents â€” each agent gets its own inbox to send and receive mail with just an API key (no user OAuth).', ['send_message', 'create_inbox', 'list_inboxes', 'list_messages'], bearerCredential, 'https://docs.agentmail.to/llms.txt', 'implemented'),
  manifest('github', 'GitHub', 'Code', 'Create issues, comment, and trigger GitHub Actions workflows.', ['create_issue', 'comment_issue', 'trigger_workflow', 'get_run_status'], bearerCredential, 'https://docs.github.com/rest', 'implemented'),
  manifest('google_sheets', 'Google Sheets', 'Productivity', 'Read, append, update, and clear spreadsheet ranges.', ['append_row', 'read_range', 'update_range', 'clear_range'], oauthCredential, 'https://developers.google.com/sheets/api/reference/rest', 'implemented'),
  manifest('email_smtp', 'SMTP Email', 'Communication', 'Send email through a configured SMTP transport.', ['send_email'], { type: 'smtp', fields: ['host', 'port', 'username', 'password'] }),
  manifest('postgres', 'Postgres', 'Data', 'Execute SQL and write rows to Postgres databases.', ['execute_query', 'insert', 'update', 'upsert'], { type: 'connection_string', fields: ['connectionString'] }),
  manifest('discord', 'Discord', 'Communication', 'Send messages and create threads.', ['send_message', 'create_thread'], bearerCredential),
  manifest('telegram', 'Telegram', 'Communication', 'Send Telegram messages and photos.', ['send_message', 'send_photo'], bearerCredential),
  manifest('outlook', 'Outlook', 'Communication', 'Send and search Outlook mail.', ['send_email', 'read_inbox', 'search'], oauthCredential),
  manifest('twilio', 'Twilio', 'SMS & Voice', 'Send SMS, WhatsApp, and voice calls.', ['send_sms', 'make_call', 'send_whatsapp'], twilioCredential),
  manifest('vonage', 'Vonage', 'SMS & Voice', 'Send SMS and make calls.', ['send_sms', 'make_call'], apiKeyCredential),
  manifest('notion', 'Notion', 'Productivity', 'Create pages, update pages, and query databases.', ['create_page', 'update_page', 'query_database', 'append_block'], bearerCredential),
  manifest('airtable', 'Airtable', 'Productivity', 'Create, update, query, and delete records.', ['create_record', 'update_record', 'query', 'delete_record'], bearerCredential),
  manifest('google_docs', 'Google Docs', 'Productivity', 'Create documents, append text, and read document content.', ['create_doc', 'append_text', 'read_doc'], oauthCredential),
  manifest('trello', 'Trello', 'Productivity', 'Create cards, move cards, and add comments.', ['create_card', 'update_card', 'move_card', 'add_comment'], trelloCredential),
  manifest('linear', 'Linear', 'Productivity', 'Create issues, update issues, and add comments.', ['create_issue', 'update_issue', 'add_comment'], bearerCredential),
  manifest('jira', 'Jira', 'Productivity', 'Create, update, comment, and transition issues.', ['create_issue', 'update_issue', 'add_comment', 'transition'], jiraCredential),
  manifest('asana', 'Asana', 'Productivity', 'Create tasks, update tasks, and add comments.', ['create_task', 'update_task', 'add_comment'], bearerCredential),
  manifest('clickup', 'ClickUp', 'Productivity', 'Create tasks, update tasks, and set statuses.', ['create_task', 'update_task', 'set_status'], apiKeyCredential),
  manifest('gitlab', 'GitLab', 'Code', 'Create issues, create merge requests, and trigger pipelines.', ['create_issue', 'create_mr', 'trigger_pipeline'], bearerCredential),
  manifest('bitbucket', 'Bitbucket', 'Code', 'Create pull requests and add comments.', ['create_pr', 'add_comment'], bearerCredential),
  manifest('hubspot', 'HubSpot', 'CRM', 'Create contacts, update contacts, create deals, and add notes.', ['create_contact', 'update_contact', 'create_deal', 'add_note'], bearerCredential),
  manifest('salesforce', 'Salesforce', 'CRM', 'Create records, update records, and run SOQL queries.', ['create_record', 'update_record', 'query'], oauthCredential),
  manifest('pipedrive', 'Pipedrive', 'CRM', 'Create deals, update deals, and create people.', ['create_deal', 'update_deal', 'create_person'], apiKeyCredential),
  manifest('zendesk', 'Zendesk', 'Support', 'Create, update, comment, and close tickets.', ['create_ticket', 'update_ticket', 'add_comment', 'close_ticket'], zendeskCredential),
  manifest('intercom', 'Intercom', 'Support', 'Create conversations, send messages, and tag users.', ['create_conversation', 'send_message', 'tag_user'], bearerCredential),
  manifest('freshdesk', 'Freshdesk', 'Support', 'Create tickets, update tickets, and reply to tickets.', ['create_ticket', 'update_ticket', 'reply_to_ticket'], apiKeyCredential),
  manifest('mysql', 'MySQL', 'Data', 'Execute SQL and write rows to MySQL databases.', ['execute_query', 'insert', 'update', 'upsert'], { type: 'connection_string', fields: ['connectionString'] }),
  manifest('mongodb', 'MongoDB', 'Data', 'Find, insert, update, and delete documents.', ['find', 'find_one', 'insert_one', 'update_one', 'delete_one'], { type: 'connection_string', fields: ['connectionString'] }),
  manifest('redis', 'Redis', 'Data', 'Get, set, delete, expire, and publish Redis values.', ['get', 'set', 'del', 'expire', 'publish'], { type: 'connection_string', fields: ['connectionString'] }),
  manifest('supabase', 'Supabase', 'Data', 'Select, insert, update, and delete via Supabase REST.', ['select', 'insert', 'update', 'delete'], supabaseCredential),
  manifest('elasticsearch', 'Elasticsearch', 'Search', 'Index documents, search, and delete documents.', ['index_document', 'search', 'delete_document'], apiKeyCredential),
  manifest('algolia', 'Algolia', 'Search', 'Save, search, delete, and partially update objects.', ['save_object', 'search', 'delete_object', 'partial_update'], apiKeyCredential),
  manifest('sqs', 'Amazon SQS', 'Queues', 'Send, receive, and delete queue messages.', ['send_message', 'receive_messages', 'delete_message'], apiKeyCredential),
  manifest('pubsub', 'Google Pub/Sub', 'Queues', 'Publish and pull messages.', ['publish', 'pull_messages'], oauthCredential),
  manifest('rabbitmq', 'RabbitMQ', 'Queues', 'Publish and consume AMQP messages.', ['publish', 'consume'], { type: 'connection_string', fields: ['connectionString'] }),
  manifest('kafka', 'Kafka', 'Queues', 'Produce and consume messages through a Kafka-compatible endpoint.', ['produce', 'consume'], { type: 'connection_string', fields: ['connectionString'] }),
  manifest('google_drive', 'Google Drive', 'Files', 'Upload, download, list, and share Drive files.', ['upload_file', 'download_file', 'list_files', 'share'], oauthCredential),
  manifest('dropbox', 'Dropbox', 'Files', 'Upload, download, list, and share files.', ['upload', 'download', 'list', 'share'], bearerCredential),
  manifest('s3', 'S3 / R2 / MinIO', 'Files', 'Put, get, list, and delete objects.', ['put_object', 'get_object', 'list_objects', 'delete_object'], apiKeyCredential),
  manifest('ftp', 'FTP', 'Files', 'Upload, download, and list FTP files.', ['upload', 'download', 'list'], { type: 'username_password', fields: ['host', 'username', 'password'] }),
  manifest('contentful', 'Contentful', 'CMS', 'Get, create, update, and publish entries.', ['get_entry', 'create_entry', 'update_entry', 'publish'], bearerCredential),
  manifest('sanity', 'Sanity', 'CMS', 'Get, create, and patch documents.', ['get_document', 'create_document', 'patch_document'], bearerCredential),
  manifest('strapi', 'Strapi', 'CMS', 'Find, create, update, and delete content.', ['find', 'find_one', 'create', 'update', 'delete'], bearerCredential),
  manifest('wordpress', 'WordPress', 'CMS', 'Get, create, and update posts through WP REST.', ['get_post', 'create_post', 'update_post'], wordpressCredential),
  manifest('shopify', 'Shopify', 'Ecommerce', 'Get orders, create orders, update products, and get customers.', ['get_order', 'create_order', 'update_product', 'get_customer'], bearerCredential),
  manifest('woocommerce', 'WooCommerce', 'Ecommerce', 'Get orders, create products, and update orders.', ['get_order', 'create_product', 'update_order'], apiKeyCredential),
  manifest('typeform', 'Typeform', 'Forms', 'Get responses, forms, and form lists.', ['get_responses', 'get_form', 'list_forms'], bearerCredential),
  manifest('google_forms', 'Google Forms', 'Forms', 'Get responses through Google APIs.', ['get_responses'], oauthCredential),
  manifest('zoom', 'Zoom', 'Meetings', 'Create meetings, get recordings, and list participants.', ['create_meeting', 'get_recording', 'list_participants'], oauthCredential),
  manifest('google_meet', 'Google Meet', 'Meetings', 'Create meetings through Calendar conference data.', ['create_meeting'], oauthCredential),
  manifest('auth0', 'Auth0', 'Auth', 'Get users, create users, update users, assign roles, and block users.', ['get_user', 'create_user', 'update_user', 'assign_role', 'block_user'], bearerCredential),
  manifest('okta', 'Okta', 'Auth', 'Get, create, deactivate users, and list groups.', ['get_user', 'create_user', 'deactivate_user', 'list_groups'], apiKeyCredential),
  manifest('openai', 'OpenAI', 'AI', 'Chat completions, embeddings, image generation, and transcription.', ['chat_completion', 'embedding', 'image_gen', 'transcribe'], bearerCredential),
  manifest('anthropic', 'Anthropic', 'AI', 'Messages and token counting.', ['messages', 'count_tokens'], bearerCredential),
  manifest('replicate', 'Replicate', 'AI', 'Run models and fetch predictions.', ['run_model', 'get_prediction'], bearerCredential),
  manifest('twitter_x', 'X / Twitter', 'Social', 'Post tweets, search tweets, and get timelines.', ['post_tweet', 'search_tweets', 'get_user_timeline'], oauthCredential),
  manifest('linkedin', 'LinkedIn', 'Social', 'Create posts and fetch profile data.', ['create_post', 'get_profile'], oauthCredential),
  manifest('instagram', 'Instagram', 'Social', 'Create posts and fetch media through Graph API.', ['create_post', 'get_media'], oauthCredential),
  manifest('reddit', 'Reddit', 'Social', 'Submit posts and add comments.', ['submit_post', 'add_comment'], oauthCredential),
  manifest('stripe', 'Stripe', 'Payments', 'Create payment intents, customers, invoices, and retrieve subscriptions.', ['create_payment_intent', 'create_customer', 'create_invoice', 'retrieve_subscription'], bearerCredential),
  manifest('paypal', 'PayPal', 'Payments', 'Create orders, capture orders, and create subscriptions.', ['create_order', 'capture_order', 'create_subscription'], oauthCredential),
  manifest('paddle', 'Paddle', 'Payments', 'Create transactions and manage subscriptions.', ['create_transaction', 'get_subscription', 'cancel_subscription'], bearerCredential),
  manifest('google_calendar', 'Google Calendar', 'Calendar', 'Create, list, update, and delete events.', ['create_event', 'list_events', 'update_event', 'delete_event'], oauthCredential),
  manifest('datadog', 'Datadog', 'Monitoring', 'Create events, send metrics, get logs, and create incidents.', ['create_event', 'send_metric', 'get_logs', 'create_incident'], apiKeyCredential),
  manifest('sentry', 'Sentry', 'Monitoring', 'Get issues, resolve issues, and create releases.', ['get_issues', 'resolve_issue', 'create_release'], bearerCredential),
  manifest('pagerduty', 'PagerDuty', 'Monitoring', 'Create incidents, resolve incidents, and get on-call schedules.', ['create_incident', 'resolve_incident', 'get_on_call'], apiKeyCredential),
  manifest('new_relic', 'New Relic', 'Monitoring', 'Insert events, query NRQL, and create alert conditions.', ['insert_event', 'query_nrql', 'create_alert_condition'], apiKeyCredential),
  manifest('google_analytics', 'Google Analytics', 'Analytics', 'Run GA4 reports.', ['get_report'], oauthCredential),
  manifest('mixpanel', 'Mixpanel', 'Analytics', 'Track events, get reports, and create cohorts.', ['track_event', 'get_report', 'create_cohort'], apiKeyCredential),
  manifest('rss_feed', 'RSS Feed', 'Web', 'Fetch and parse RSS or Atom feed items.', ['fetch_feed', 'parse_items'], noCredential),

  // WORKFLOW-UPDATE â€” n8n-inspired high-value integrations.
  // Communication
  manifest('teams', 'Microsoft Teams', 'Communication', 'Send channel messages and create channels.', ['send_message', 'create_channel'], oauthCredential),
  manifest('whatsapp', 'WhatsApp Business', 'Communication', 'Send WhatsApp messages and templates via the Business API.', ['send_message', 'send_template'], bearerCredential),
  manifest('line', 'LINE', 'Communication', 'Push and reply to LINE messages.', ['push_message', 'reply_message'], bearerCredential),
  // CRM
  manifest('zoho_crm', 'Zoho CRM', 'CRM', 'Create, update, and search Zoho CRM records.', ['create_record', 'update_record', 'search'], oauthCredential),
  manifest('monday_com', 'Monday.com', 'CRM', 'Create items, update columns, and query boards.', ['create_item', 'update_column', 'query_board'], bearerCredential),
  manifest('attio', 'Attio', 'CRM', 'Create and update records and lists in Attio.', ['create_record', 'update_record', 'add_to_list'], bearerCredential),
  // Data / Engineering
  manifest('snowflake', 'Snowflake', 'Data', 'Run SQL and load rows into Snowflake.', ['execute_query', 'insert', 'bulk_load'], { type: 'api_key', fields: ['account', 'username', 'password', 'warehouse'] }),
  manifest('bigquery', 'Google BigQuery', 'Data', 'Run queries and insert rows into BigQuery.', ['query', 'insert_rows', 'create_table'], oauthCredential),
  manifest('dynamodb', 'AWS DynamoDB', 'Data', 'Get, put, query, and delete items.', ['get_item', 'put_item', 'query', 'delete_item'], apiKeyCredential),
  manifest('pinecone', 'Pinecone', 'Data', 'Upsert, query, and delete vectors.', ['upsert', 'query', 'delete'], apiKeyCredential),
  manifest('qdrant', 'Qdrant', 'Data', 'Upsert, search, and delete points.', ['upsert', 'search', 'delete'], apiKeyCredential),
  // Files
  manifest('box', 'Box', 'Files', 'Upload, download, and share files.', ['upload', 'download', 'share'], oauthCredential),
  manifest('onedrive', 'OneDrive', 'Files', 'Upload, download, and list files.', ['upload', 'download', 'list'], oauthCredential),
  manifest('sharepoint', 'SharePoint', 'Files', 'List items, upload files, and read lists.', ['list_items', 'upload_file', 'read_list'], oauthCredential),
  // Monitoring
  manifest('grafana', 'Grafana', 'Monitoring', 'Create annotations and read dashboards.', ['create_annotation', 'get_dashboard', 'list_dashboards'], bearerCredential),
  manifest('splunk', 'Splunk', 'Monitoring', 'Ingest events via HEC and run searches.', ['ingest_event', 'search'], { type: 'api_key', fields: ['hecUrl', 'hecToken'] }),
  // Marketing
  manifest('mailchimp', 'Mailchimp', 'Marketing', 'Manage lists, add members, and send campaigns.', ['add_member', 'update_member', 'create_campaign', 'send_campaign'], { type: 'api_key', fields: ['apiKey', 'serverPrefix'] }),
  manifest('sendgrid_marketing', 'SendGrid Marketing', 'Marketing', 'Manage marketing contacts and lists.', ['add_contact', 'create_list', 'send_marketing_email'], bearerCredential),
  manifest('youtube', 'YouTube', 'Marketing', 'Upload videos and read channel analytics.', ['upload_video', 'get_analytics', 'list_videos'], oauthCredential),
  // DevOps
  manifest('vercel', 'Vercel', 'DevOps', 'Deploy generated sites to Vercel (inline files, no git/CLI needed) and read project/deployment status.', ['create_deployment', 'get_deployment', 'list_deployments', 'list_projects'], bearerCredential, 'https://vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment'),
  manifest('jenkins', 'Jenkins', 'DevOps', 'Trigger builds and read job status.', ['trigger_build', 'get_build_status', 'list_jobs'], { type: 'api_key', fields: ['baseUrl', 'username', 'apiToken'] }),
  manifest('circleci', 'CircleCI', 'DevOps', 'Trigger pipelines and read job status.', ['trigger_pipeline', 'get_pipeline', 'get_job_status'], bearerCredential),
  // Finance
  manifest('chargebee', 'Chargebee', 'Payments', 'Create subscriptions, customers, and invoices.', ['create_subscription', 'create_customer', 'create_invoice'], { type: 'api_key', fields: ['site', 'apiKey'] }),
  manifest('quickbooks', 'QuickBooks', 'Payments', 'Create invoices, customers, and read reports.', ['create_invoice', 'create_customer', 'get_report'], oauthCredential),
];

export const builtinIntegrationManifests: IntegrationManifest[] = seeds.map((seed) => ({
  ...seed,
  version: '1.0.0',
  nodeConfig: { kind: 'integration', service: seed.service, operation: seed.operations[0] },
  builtin: true,
  runtime: seed.runtime ?? 'manifest_only',
}));

function manifest(
  service: string,
  name: string,
  category: string,
  description: string,
  operations: string[],
  credentialSchema: Record<string, unknown>,
  docsUrl?: string,
  runtime?: IntegrationManifest['runtime'],
): ManifestSeed {
  return { service, name, category, description, operations, credentialSchema, docsUrl, icon: service, runtime };
}



