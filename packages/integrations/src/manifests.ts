import type { IntegrationManifest } from './types.js';

type ManifestSeed = Omit<IntegrationManifest, 'version' | 'nodeConfig' | 'builtin' | 'runtime'> & {
  runtime?: IntegrationManifest['runtime'];
};

interface ManifestOpts {
  docsUrl?: string;
  runtime?: IntegrationManifest['runtime'];
  /** One line telling the operator exactly where to get this credential. */
  authHint?: string;
}

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
// Microsoft Graph app-only (client-credentials) auth — BYOC path for the Microsoft
// family: no interactive OAuth app is wired in this build (see PROVIDER_DEFS in
// oauthService.ts), so operators register an Azure AD app themselves.
const microsoftGraphCredential = { type: 'api_key', fields: ['tenantId', 'clientId', 'clientSecret'] };

// Real, working "Sign in with X" — BYOC: the operator pastes their own OAuth
// app's Client ID/Secret into Settings → Integrations (takes effect
// immediately, no restart — see OAuthAppCredentialStore), or an instance
// admin can set OAUTH_<PROVIDER>_CLIENT_ID/SECRET env vars instead (env
// always wins if both are set). This is an instance-wide setting, not a
// per-user paste, so the hint says so explicitly.
function oauthAdminHint(provider: 'google' | 'linkedin' | 'twitter_x', consoleHint: string): string {
  const label = provider === 'google' ? 'Google' : provider === 'linkedin' ? 'LinkedIn' : 'X';
  return `${label} sign-in — click "Set up ${label} sign-in" and paste the Client ID/Secret from your own OAuth app (${consoleHint}, redirect URI <your-agentis-url>/v1/oauth/${provider}/callback). Takes effect immediately, no restart.`;
}

const googleHint = oauthAdminHint('google', 'create an OAuth client at Google Cloud Console → APIs & Services → Credentials');

const seeds: ManifestSeed[] = [
  manifest('http_request', 'HTTP Request', 'Core', 'Raw HTTP request with flexible auth and response parsing.', ['request'], noCredential, {
    docsUrl: 'https://developer.mozilla.org/docs/Web/API/fetch', runtime: 'implemented',
  }),
  manifest('webhook_send', 'Webhook Send', 'Core', 'Send signed outbound webhook payloads.', ['send'], { type: 'shared_secret', fields: ['secret'] }, {
    runtime: 'implemented',
    authHint: 'Any secret you choose — set the same value on the receiving endpoint to verify the HMAC signature.',
  }),
  manifest('slack', 'Slack', 'Communication', 'Post messages and reactions to Slack workspaces.', ['send_message', 'add_reaction'], bearerCredential, {
    docsUrl: 'https://api.slack.com/methods', runtime: 'implemented',
    authHint: 'Bot User OAuth Token from your Slack app → OAuth & Permissions (starts with xoxb-).',
  }),
  manifest('gmail', 'Gmail', 'Communication', 'Send Gmail messages through the Google API.', ['send_email'], oauthCredential, {
    docsUrl: 'https://developers.google.com/gmail/api/reference/rest', runtime: 'implemented',
    authHint: googleHint,
  }),
  manifest('agentmail', 'AgentMail', 'Communication', 'Email built for agents — each agent gets its own inbox to send and receive mail with just an API key (no user OAuth).', ['send_message', 'create_inbox', 'list_inboxes', 'list_messages'], bearerCredential, {
    docsUrl: 'https://docs.agentmail.to/llms.txt', runtime: 'implemented',
    authHint: 'API key from your AgentMail dashboard → API Keys.',
  }),
  manifest('github', 'GitHub', 'Code', 'Create issues, comment, and trigger GitHub Actions workflows.', ['create_issue', 'comment_issue', 'trigger_workflow', 'get_run_status'], bearerCredential, {
    docsUrl: 'https://docs.github.com/rest', runtime: 'implemented',
    authHint: 'Personal Access Token (repo, workflow scopes) from GitHub → Settings → Developer settings → Personal access tokens.',
  }),
  manifest('google_sheets', 'Google Sheets', 'Productivity', 'Read, append, update, and clear spreadsheet ranges.', ['append_row', 'read_range', 'update_range', 'clear_range'], oauthCredential, {
    docsUrl: 'https://developers.google.com/sheets/api/reference/rest', runtime: 'implemented',
    authHint: googleHint,
  }),
  manifest('email_smtp', 'SMTP Email', 'Communication', 'Send email through a configured SMTP transport.', ['send_email'], { type: 'smtp', fields: ['host', 'port', 'username', 'password'] }, {
    authHint: "Your mail provider's SMTP host/port and a mailbox username + password (Gmail/Outlook require an app-specific password, not your normal login password).",
  }),
  manifest('postgres', 'Postgres', 'Data', 'Execute SQL and write rows to Postgres databases.', ['execute_query', 'insert', 'update', 'upsert'], { type: 'connection_string', fields: ['connectionString'] }, {
    authHint: "A full connection string (postgres://user:pass@host:5432/dbname) from your database provider's connection settings.",
  }),
  manifest('discord', 'Discord', 'Communication', 'Send messages and create threads.', ['send_message', 'create_thread'], bearerCredential, {
    docsUrl: 'https://discord.com/developers/docs/intro',
    authHint: 'Bot token from the Discord Developer Portal → your application → Bot → Reset Token.',
  }),
  manifest('telegram', 'Telegram', 'Communication', 'Send Telegram messages and photos.', ['send_message', 'send_photo'], bearerCredential, {
    docsUrl: 'https://core.telegram.org/bots/api',
    authHint: 'Bot token from @BotFather on Telegram (send /newbot).',
  }),
  manifest('outlook', 'Outlook', 'Communication', 'Send and search Outlook mail.', ['send_email', 'read_inbox', 'search'], microsoftGraphCredential, {
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview',
    authHint: 'Azure AD app registration → Certificates & secrets for a client secret, plus your Tenant ID and Application (client) ID — grant Mail.Send/Mail.Read application permissions.',
  }),
  manifest('twilio', 'Twilio', 'SMS & Voice', 'Send SMS, WhatsApp, and voice calls.', ['send_sms', 'make_call', 'send_whatsapp'], twilioCredential, {
    docsUrl: 'https://www.twilio.com/docs/usage/api',
    authHint: 'Account SID and Auth Token from the Twilio Console dashboard.',
  }),
  manifest('vonage', 'Vonage', 'SMS & Voice', 'Send SMS and make calls.', ['send_sms', 'make_call'], apiKeyCredential, {
    docsUrl: 'https://developer.vonage.com/en/api/sms',
    authHint: 'API Key from the Vonage API Dashboard (Vonage also requires an API Secret for most calls — see their docs for how it is passed).',
  }),
  manifest('notion', 'Notion', 'Productivity', 'Create pages, update pages, and query databases.', ['create_page', 'update_page', 'query_database', 'append_block'], bearerCredential, {
    docsUrl: 'https://developers.notion.com/reference/intro',
    authHint: 'Internal Integration Secret from Notion → My Integrations → New integration.',
  }),
  manifest('airtable', 'Airtable', 'Productivity', 'Create, update, query, and delete records.', ['create_record', 'update_record', 'query', 'delete_record'], bearerCredential, {
    docsUrl: 'https://airtable.com/developers/web/api/introduction',
    authHint: 'Personal access token from Airtable → Developer Hub → Personal access tokens.',
  }),
  manifest('google_docs', 'Google Docs', 'Productivity', 'Create documents, append text, and read document content.', ['create_doc', 'append_text', 'read_doc'], oauthCredential, {
    authHint: googleHint,
  }),
  manifest('trello', 'Trello', 'Productivity', 'Create cards, move cards, and add comments.', ['create_card', 'update_card', 'move_card', 'add_comment'], trelloCredential, {
    docsUrl: 'https://developer.atlassian.com/cloud/trello/rest/',
    authHint: 'API Key + Token from trello.com/power-ups/admin (create a Power-Up, then generate a token).',
  }),
  manifest('linear', 'Linear', 'Productivity', 'Create issues, update issues, and add comments.', ['create_issue', 'update_issue', 'add_comment'], bearerCredential, {
    docsUrl: 'https://developers.linear.app',
    authHint: 'Personal API key from Linear → Settings → API → Personal API keys.',
  }),
  manifest('jira', 'Jira', 'Productivity', 'Create, update, comment, and transition issues.', ['create_issue', 'update_issue', 'add_comment', 'transition'], jiraCredential, {
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/',
    authHint: 'Your Jira site URL, account email, and an API token from id.atlassian.com/manage-profile/security/api-tokens.',
  }),
  manifest('asana', 'Asana', 'Productivity', 'Create tasks, update tasks, and add comments.', ['create_task', 'update_task', 'add_comment'], bearerCredential, {
    docsUrl: 'https://developers.asana.com/docs',
    authHint: 'Personal access token from Asana → My Settings → Apps → Developer App → Personal Access Tokens.',
  }),
  manifest('clickup', 'ClickUp', 'Productivity', 'Create tasks, update tasks, and set statuses.', ['create_task', 'update_task', 'set_status'], apiKeyCredential, {
    docsUrl: 'https://developer.clickup.com/reference',
    authHint: 'Personal API token from ClickUp → Settings → Apps.',
  }),
  manifest('gitlab', 'GitLab', 'Code', 'Create issues, create merge requests, and trigger pipelines.', ['create_issue', 'create_mr', 'trigger_pipeline'], bearerCredential, {
    docsUrl: 'https://docs.gitlab.com/ee/api/rest/',
    authHint: 'Personal access token from GitLab → Preferences → Access Tokens (api scope).',
  }),
  manifest('bitbucket', 'Bitbucket', 'Code', 'Create pull requests and add comments.', ['create_pr', 'add_comment'], bearerCredential, {
    docsUrl: 'https://developer.atlassian.com/cloud/bitbucket/rest/intro/',
    authHint: 'App password from Bitbucket → Personal settings → App passwords.',
  }),
  manifest('hubspot', 'HubSpot', 'CRM', 'Create contacts, update contacts, create deals, and add notes.', ['create_contact', 'update_contact', 'create_deal', 'add_note'], bearerCredential, {
    docsUrl: 'https://developers.hubspot.com/docs/api/overview',
    authHint: 'Private app access token from HubSpot → Settings → Integrations → Private Apps.',
  }),
  manifest('salesforce', 'Salesforce', 'CRM', 'Create records, update records, and run SOQL queries.', ['create_record', 'update_record', 'query'], { type: 'api_key', fields: ['instanceUrl', 'accessToken'] }, {
    authHint: 'Instance URL + access token — create a Connected App in Salesforce Setup, then obtain a token via its OAuth flow or the Salesforce CLI (sf org display --verbose).',
  }),
  manifest('pipedrive', 'Pipedrive', 'CRM', 'Create deals, update deals, and create people.', ['create_deal', 'update_deal', 'create_person'], apiKeyCredential, {
    docsUrl: 'https://developers.pipedrive.com/docs/api/v1',
    authHint: 'API token from Pipedrive → Settings → Personal preferences → API.',
  }),
  manifest('zendesk', 'Zendesk', 'Support', 'Create, update, comment, and close tickets.', ['create_ticket', 'update_ticket', 'add_comment', 'close_ticket'], zendeskCredential, {
    docsUrl: 'https://developer.zendesk.com/api-reference/',
    authHint: 'Your Zendesk subdomain, agent email, and an API token from Admin Center → Apps and integrations → APIs → Zendesk API.',
  }),
  manifest('intercom', 'Intercom', 'Support', 'Create conversations, send messages, and tag users.', ['create_conversation', 'send_message', 'tag_user'], bearerCredential, {
    docsUrl: 'https://developers.intercom.com/docs/references/rest-api/',
    authHint: 'Access token from Intercom → Settings → Developer Hub → your app → Authentication.',
  }),
  manifest('freshdesk', 'Freshdesk', 'Support', 'Create tickets, update tickets, and reply to tickets.', ['create_ticket', 'update_ticket', 'reply_to_ticket'], apiKeyCredential, {
    docsUrl: 'https://developers.freshdesk.com/api/',
    authHint: 'API key from Freshdesk → Profile Settings → API Key.',
  }),
  manifest('mysql', 'MySQL', 'Data', 'Execute SQL and write rows to MySQL databases.', ['execute_query', 'insert', 'update', 'upsert'], { type: 'connection_string', fields: ['connectionString'] }, {
    authHint: 'A full connection string (mysql://user:pass@host:3306/dbname).',
  }),
  manifest('mongodb', 'MongoDB', 'Data', 'Find, insert, update, and delete documents.', ['find', 'find_one', 'insert_one', 'update_one', 'delete_one'], { type: 'connection_string', fields: ['connectionString'] }, {
    docsUrl: 'https://www.mongodb.com/docs/manual/reference/',
    authHint: 'A connection string (mongodb+srv://user:pass@cluster/dbname) from your Atlas cluster or self-hosted instance.',
  }),
  manifest('redis', 'Redis', 'Data', 'Get, set, delete, expire, and publish Redis values.', ['get', 'set', 'del', 'expire', 'publish'], { type: 'connection_string', fields: ['connectionString'] }, {
    authHint: "A Redis connection string (redis://user:pass@host:6379) from your provider's dashboard.",
  }),
  manifest('supabase', 'Supabase', 'Data', 'Select, insert, update, and delete via Supabase REST.', ['select', 'insert', 'update', 'delete'], supabaseCredential, {
    docsUrl: 'https://supabase.com/docs/reference/api',
    authHint: 'Project URL and service_role (or anon) key from Supabase → Project Settings → API.',
  }),
  manifest('elasticsearch', 'Elasticsearch', 'Search', 'Index documents, search, and delete documents.', ['index_document', 'search', 'delete_document'], apiKeyCredential, {
    docsUrl: 'https://www.elastic.co/guide/en/elasticsearch/reference/current/rest-apis.html',
    authHint: 'An API key generated from Kibana → Stack Management → API Keys (or your cluster security API).',
  }),
  manifest('algolia', 'Algolia', 'Search', 'Save, search, delete, and partially update objects.', ['save_object', 'search', 'delete_object', 'partial_update'], apiKeyCredential, {
    docsUrl: 'https://www.algolia.com/doc/rest-api/search/',
    authHint: 'Admin API Key from Algolia → your app → Settings → API Keys.',
  }),
  manifest('sqs', 'Amazon SQS', 'Queues', 'Send, receive, and delete queue messages.', ['send_message', 'receive_messages', 'delete_message'], apiKeyCredential, {
    docsUrl: 'https://docs.aws.amazon.com/AmazonSQS/latest/APIReference/Welcome.html',
    authHint: 'AWS access key ID + secret access key with SQS permissions, from IAM → Users → Security credentials.',
  }),
  manifest('pubsub', 'Google Pub/Sub', 'Queues', 'Publish and pull messages.', ['publish', 'pull_messages'], oauthCredential, {
    authHint: googleHint,
  }),
  manifest('rabbitmq', 'RabbitMQ', 'Queues', 'Publish and consume AMQP messages.', ['publish', 'consume'], { type: 'connection_string', fields: ['connectionString'] }, {
    authHint: "An AMQP connection string (amqps://user:pass@host:5671/vhost) from your broker's dashboard.",
  }),
  manifest('kafka', 'Kafka', 'Queues', 'Produce and consume messages through a Kafka-compatible endpoint.', ['produce', 'consume'], { type: 'connection_string', fields: ['connectionString'] }, {
    authHint: 'A bootstrap connection string for your Kafka-compatible cluster (host:port, plus SASL credentials if enabled).',
  }),
  manifest('google_drive', 'Google Drive', 'Files', 'Upload, download, list, and share Drive files.', ['upload_file', 'download_file', 'list_files', 'share'], oauthCredential, {
    authHint: googleHint,
  }),
  manifest('dropbox', 'Dropbox', 'Files', 'Upload, download, list, and share files.', ['upload', 'download', 'list', 'share'], bearerCredential, {
    docsUrl: 'https://www.dropbox.com/developers/documentation/http/documentation',
    authHint: 'Access token from the Dropbox App Console → your app → Generated access token (or wire up OAuth2 for a long-lived token).',
  }),
  manifest('s3', 'S3 / R2 / MinIO', 'Files', 'Put, get, list, and delete objects.', ['put_object', 'get_object', 'list_objects', 'delete_object'], apiKeyCredential, {
    docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html',
    authHint: "Access key ID + secret access key from AWS IAM (or your R2/MinIO provider's equivalent credentials).",
  }),
  manifest('ftp', 'FTP', 'Files', 'Upload, download, and list FTP files.', ['upload', 'download', 'list'], { type: 'username_password', fields: ['host', 'username', 'password'] }, {
    authHint: 'The host, username, and password from your FTP hosting provider — no key generation needed.',
  }),
  manifest('contentful', 'Contentful', 'CMS', 'Get, create, update, and publish entries.', ['get_entry', 'create_entry', 'update_entry', 'publish'], bearerCredential, {
    docsUrl: 'https://www.contentful.com/developers/docs/references/content-management-api/',
    authHint: 'Content Management API token from Contentful → Settings → API keys → Content management tokens.',
  }),
  manifest('sanity', 'Sanity', 'CMS', 'Get, create, and patch documents.', ['get_document', 'create_document', 'patch_document'], bearerCredential, {
    docsUrl: 'https://www.sanity.io/docs/http-api',
    authHint: 'API token from sanity.io/manage → your project → API → Tokens.',
  }),
  manifest('strapi', 'Strapi', 'CMS', 'Find, create, update, and delete content.', ['find', 'find_one', 'create', 'update', 'delete'], bearerCredential, {
    docsUrl: 'https://docs.strapi.io/dev-docs/api/rest',
    authHint: 'API token from your Strapi admin panel → Settings → API Tokens.',
  }),
  manifest('wordpress', 'WordPress', 'CMS', 'Get, create, and update posts through WP REST.', ['get_post', 'create_post', 'update_post'], wordpressCredential, {
    docsUrl: 'https://developer.wordpress.org/rest-api/',
    authHint: 'Your site URL, WP username, and an Application Password from WP Admin → Users → Profile → Application Passwords.',
  }),
  manifest('shopify', 'Shopify', 'Ecommerce', 'Get orders, create orders, update products, and get customers.', ['get_order', 'create_order', 'update_product', 'get_customer'], bearerCredential, {
    docsUrl: 'https://shopify.dev/docs/api/admin-rest',
    authHint: 'Admin API access token from Shopify Admin → Settings → Apps and sales channels → Develop apps → your app → API credentials.',
  }),
  manifest('woocommerce', 'WooCommerce', 'Ecommerce', 'Get orders, create products, and update orders.', ['get_order', 'create_product', 'update_order'], apiKeyCredential, {
    docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    authHint: 'Consumer key + secret from WooCommerce → Settings → Advanced → REST API → Add key.',
  }),
  manifest('typeform', 'Typeform', 'Forms', 'Get responses, forms, and form lists.', ['get_responses', 'get_form', 'list_forms'], bearerCredential, {
    docsUrl: 'https://developer.typeform.com',
    authHint: 'Personal access token from Typeform → Account settings → Personal tokens.',
  }),
  manifest('google_forms', 'Google Forms', 'Forms', 'Get responses through Google APIs.', ['get_responses'], oauthCredential, {
    authHint: googleHint,
  }),
  manifest('zoom', 'Zoom', 'Meetings', 'Create meetings, get recordings, and list participants.', ['create_meeting', 'get_recording', 'list_participants'], { type: 'api_key', fields: ['accountId', 'clientId', 'clientSecret'] }, {
    docsUrl: 'https://developers.zoom.us/docs/api/',
    authHint: 'Server-to-Server OAuth app credentials from the Zoom App Marketplace → Build App → Server-to-Server OAuth (Account ID, Client ID, Client Secret).',
  }),
  manifest('google_meet', 'Google Meet', 'Meetings', 'Create meetings through Calendar conference data.', ['create_meeting'], oauthCredential, {
    authHint: googleHint,
  }),
  manifest('auth0', 'Auth0', 'Auth', 'Get users, create users, update users, assign roles, and block users.', ['get_user', 'create_user', 'update_user', 'assign_role', 'block_user'], bearerCredential, {
    docsUrl: 'https://auth0.com/docs/api/management/v2',
    authHint: "A Machine-to-Machine app's Management API token from your Auth0 tenant → Applications → APIs → Auth0 Management API.",
  }),
  manifest('okta', 'Okta', 'Auth', 'Get, create, deactivate users, and list groups.', ['get_user', 'create_user', 'deactivate_user', 'list_groups'], apiKeyCredential, {
    docsUrl: 'https://developer.okta.com/docs/reference/',
    authHint: 'API token from Okta Admin → Security → API → Tokens.',
  }),
  manifest('openai', 'OpenAI', 'AI', 'Chat completions, embeddings, image generation, and transcription.', ['chat_completion', 'embedding', 'image_gen', 'transcribe'], bearerCredential, {
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    authHint: 'API key from platform.openai.com/api-keys.',
  }),
  manifest('anthropic', 'Anthropic', 'AI', 'Messages and token counting.', ['messages', 'count_tokens'], bearerCredential, {
    docsUrl: 'https://docs.anthropic.com',
    authHint: 'API key from console.anthropic.com/settings/keys.',
  }),
  manifest('replicate', 'Replicate', 'AI', 'Run models and fetch predictions.', ['run_model', 'get_prediction'], bearerCredential, {
    docsUrl: 'https://replicate.com/docs/reference/http',
    authHint: 'API token from replicate.com/account/api-tokens.',
  }),
  manifest('twitter_x', 'X / Twitter', 'Social', 'Post tweets, search tweets, and get timelines.', ['post_tweet', 'search_tweets', 'get_user_timeline'], oauthCredential, {
    authHint: oauthAdminHint('twitter_x', 'developer.x.com → your app → Keys and tokens → OAuth 2.0 Client ID and Secret'),
  }),
  manifest('linkedin', 'LinkedIn', 'Social', 'Create posts and fetch profile data.', ['create_post', 'get_profile'], oauthCredential, {
    authHint: oauthAdminHint('linkedin', 'LinkedIn Developer Portal → your app → Auth'),
  }),
  manifest('instagram', 'Instagram', 'Social', 'Create posts and fetch media through Graph API.', ['create_post', 'get_media'], { type: 'api_key', fields: ['accessToken', 'igUserId'] }, {
    docsUrl: 'https://developers.facebook.com/docs/instagram-api/',
    authHint: "A long-lived access token + Instagram Business Account ID — generate via Meta's Graph API Explorer against a connected Facebook Page.",
  }),
  manifest('reddit', 'Reddit', 'Social', 'Submit posts and add comments.', ['submit_post', 'add_comment'], { type: 'api_key', fields: ['clientId', 'clientSecret', 'username', 'password'] }, {
    docsUrl: 'https://www.reddit.com/dev/api/',
    authHint: "Create a 'script' app at reddit.com/prefs/apps for the client ID/secret, plus a Reddit account username/password with API access.",
  }),
  manifest('stripe', 'Stripe', 'Payments', 'Create payment intents, customers, invoices, and retrieve subscriptions.', ['create_payment_intent', 'create_customer', 'create_invoice', 'retrieve_subscription'], bearerCredential, {
    docsUrl: 'https://docs.stripe.com/api',
    authHint: 'Secret key from Stripe Dashboard → Developers → API keys.',
  }),
  manifest('paypal', 'PayPal', 'Payments', 'Create orders, capture orders, and create subscriptions.', ['create_order', 'capture_order', 'create_subscription'], { type: 'api_key', fields: ['clientId', 'clientSecret'] }, {
    docsUrl: 'https://developer.paypal.com/docs/api/overview/',
    authHint: 'Client ID + Secret from the PayPal Developer Dashboard → Apps & Credentials (use the Live app for production).',
  }),
  manifest('paddle', 'Paddle', 'Payments', 'Create transactions and manage subscriptions.', ['create_transaction', 'get_subscription', 'cancel_subscription'], bearerCredential, {
    docsUrl: 'https://developer.paddle.com/api-reference/overview',
    authHint: 'API key from Paddle → Developer Tools → Authentication.',
  }),
  manifest('google_calendar', 'Google Calendar', 'Calendar', 'Create, list, update, and delete events.', ['create_event', 'list_events', 'update_event', 'delete_event'], oauthCredential, {
    authHint: googleHint,
  }),
  manifest('datadog', 'Datadog', 'Monitoring', 'Create events, send metrics, get logs, and create incidents.', ['create_event', 'send_metric', 'get_logs', 'create_incident'], apiKeyCredential, {
    docsUrl: 'https://docs.datadoghq.com/api/latest/',
    authHint: 'API key (and often an Application key) from Datadog → Organization Settings → API Keys.',
  }),
  manifest('sentry', 'Sentry', 'Monitoring', 'Get issues, resolve issues, and create releases.', ['get_issues', 'resolve_issue', 'create_release'], bearerCredential, {
    docsUrl: 'https://docs.sentry.io/api/',
    authHint: 'Auth token from Sentry → Settings → Account → API → Auth Tokens (or an internal integration token for org-wide scopes).',
  }),
  manifest('pagerduty', 'PagerDuty', 'Monitoring', 'Create incidents, resolve incidents, and get on-call schedules.', ['create_incident', 'resolve_incident', 'get_on_call'], apiKeyCredential, {
    docsUrl: 'https://developer.pagerduty.com/api-reference/',
    authHint: 'API key from PagerDuty → Integrations → API Access Keys.',
  }),
  manifest('new_relic', 'New Relic', 'Monitoring', 'Insert events, query NRQL, and create alert conditions.', ['insert_event', 'query_nrql', 'create_alert_condition'], apiKeyCredential, {
    authHint: 'A User API key (or Insights Insert key for events) from New Relic → API keys.',
  }),
  manifest('google_analytics', 'Google Analytics', 'Analytics', 'Run GA4 reports.', ['get_report'], oauthCredential, {
    authHint: googleHint,
  }),
  manifest('mixpanel', 'Mixpanel', 'Analytics', 'Track events, get reports, and create cohorts.', ['track_event', 'get_report', 'create_cohort'], apiKeyCredential, {
    docsUrl: 'https://developer.mixpanel.com/reference/overview',
    authHint: 'Project token (and a service account for the query API) from Mixpanel → Project Settings.',
  }),
  manifest('rss_feed', 'RSS Feed', 'Web', 'Fetch and parse RSS or Atom feed items.', ['fetch_feed', 'parse_items'], noCredential),

  // WORKFLOW-UPDATE — n8n-inspired high-value integrations.
  // Communication
  manifest('teams', 'Microsoft Teams', 'Communication', 'Send channel messages and create channels.', ['send_message', 'create_channel'], microsoftGraphCredential, {
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview',
    authHint: 'Azure AD app registration → Certificates & secrets for a client secret, plus Tenant ID and Client ID — grant ChannelMessage.Send / Channel.ReadBasic.All application permissions.',
  }),
  manifest('whatsapp', 'WhatsApp Business', 'Communication', 'Send WhatsApp messages and templates via the Business API.', ['send_message', 'send_template'], bearerCredential, {
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
    authHint: 'Permanent access token + Phone Number ID from Meta for Developers → WhatsApp → API Setup.',
  }),
  manifest('line', 'LINE', 'Communication', 'Push and reply to LINE messages.', ['push_message', 'reply_message'], bearerCredential, {
    docsUrl: 'https://developers.line.biz/en/reference/messaging-api/',
    authHint: 'Channel access token from the LINE Developers Console → your Messaging API channel.',
  }),
  // CRM
  manifest('zoho_crm', 'Zoho CRM', 'CRM', 'Create, update, and search Zoho CRM records.', ['create_record', 'update_record', 'search'], { type: 'api_key', fields: ['clientId', 'clientSecret', 'refreshToken'] }, {
    authHint: "Client ID/Secret from the Zoho API Console (Self Client), plus a refresh token generated once via Zoho's Self Client grant flow.",
  }),
  manifest('monday_com', 'Monday.com', 'CRM', 'Create items, update columns, and query boards.', ['create_item', 'update_column', 'query_board'], bearerCredential, {
    docsUrl: 'https://developer.monday.com/api-reference/docs',
    authHint: 'API token from monday.com → Avatar → Developers → My Access Tokens.',
  }),
  manifest('attio', 'Attio', 'CRM', 'Create and update records and lists in Attio.', ['create_record', 'update_record', 'add_to_list'], bearerCredential, {
    docsUrl: 'https://developers.attio.com',
    authHint: 'API key from Attio → Workspace Settings → Developers → API keys.',
  }),
  // Data / Engineering
  manifest('snowflake', 'Snowflake', 'Data', 'Run SQL and load rows into Snowflake.', ['execute_query', 'insert', 'bulk_load'], { type: 'api_key', fields: ['account', 'username', 'password', 'warehouse'] }, {
    authHint: "Your account identifier, username, password, and warehouse name from Snowflake's connection settings.",
  }),
  manifest('bigquery', 'Google BigQuery', 'Data', 'Run queries and insert rows into BigQuery.', ['query', 'insert_rows', 'create_table'], oauthCredential, {
    authHint: googleHint,
  }),
  manifest('dynamodb', 'AWS DynamoDB', 'Data', 'Get, put, query, and delete items.', ['get_item', 'put_item', 'query', 'delete_item'], apiKeyCredential, {
    docsUrl: 'https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/Welcome.html',
    authHint: 'AWS access key ID + secret access key with DynamoDB permissions, from IAM → Users → Security credentials.',
  }),
  manifest('pinecone', 'Pinecone', 'Data', 'Upsert, query, and delete vectors.', ['upsert', 'query', 'delete'], apiKeyCredential, {
    docsUrl: 'https://docs.pinecone.io/reference/api/introduction',
    authHint: 'API key from the Pinecone console → API Keys.',
  }),
  manifest('qdrant', 'Qdrant', 'Data', 'Upsert, search, and delete points.', ['upsert', 'search', 'delete'], apiKeyCredential, {
    docsUrl: 'https://qdrant.tech/documentation/',
    authHint: "API key from your Qdrant Cloud cluster's dashboard (self-hosted clusters may not require one).",
  }),
  // Files
  manifest('box', 'Box', 'Files', 'Upload, download, and share files.', ['upload', 'download', 'share'], { type: 'api_key', fields: ['clientId', 'clientSecret', 'enterpriseId'] }, {
    docsUrl: 'https://developer.box.com/reference/',
    authHint: 'Client ID/Secret + Enterprise ID from the Box Developer Console → your app → Configuration (enable Client Credentials Grant).',
  }),
  manifest('onedrive', 'OneDrive', 'Files', 'Upload, download, and list files.', ['upload', 'download', 'list'], microsoftGraphCredential, {
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/onedrive',
    authHint: 'Azure AD app registration → Certificates & secrets for a client secret, plus Tenant ID and Client ID — grant Files.ReadWrite.All application permissions.',
  }),
  manifest('sharepoint', 'SharePoint', 'Files', 'List items, upload files, and read lists.', ['list_items', 'upload_file', 'read_list'], { type: 'api_key', fields: ['tenantId', 'clientId', 'clientSecret', 'siteUrl'] }, {
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/sharepoint',
    authHint: 'Azure AD app registration → Certificates & secrets for a client secret, plus Tenant ID, Client ID, and the target site URL — grant Sites.ReadWrite.All application permissions.',
  }),
  // Monitoring
  manifest('grafana', 'Grafana', 'Monitoring', 'Create annotations and read dashboards.', ['create_annotation', 'get_dashboard', 'list_dashboards'], bearerCredential, {
    docsUrl: 'https://grafana.com/docs/grafana/latest/developers/http_api/',
    authHint: 'Service account token from Grafana → Administration → Service accounts.',
  }),
  manifest('splunk', 'Splunk', 'Monitoring', 'Ingest events via HEC and run searches.', ['ingest_event', 'search'], { type: 'api_key', fields: ['hecUrl', 'hecToken'] }, {
    authHint: 'Your HEC URL and an HTTP Event Collector token from Splunk → Settings → Data Inputs → HTTP Event Collector.',
  }),
  // Marketing
  manifest('mailchimp', 'Mailchimp', 'Marketing', 'Manage lists, add members, and send campaigns.', ['add_member', 'update_member', 'create_campaign', 'send_campaign'], { type: 'api_key', fields: ['apiKey', 'serverPrefix'] }, {
    docsUrl: 'https://mailchimp.com/developer/marketing/api/',
    authHint: 'API key from Mailchimp → Account → Extras → API keys (the server prefix, e.g. us21, is the suffix after the dash).',
  }),
  manifest('sendgrid_marketing', 'SendGrid Marketing', 'Marketing', 'Manage marketing contacts and lists.', ['add_contact', 'create_list', 'send_marketing_email'], bearerCredential, {
    docsUrl: 'https://www.twilio.com/docs/sendgrid/api-reference',
    authHint: 'API key from SendGrid → Settings → API Keys.',
  }),
  manifest('youtube', 'YouTube', 'Marketing', 'Upload videos and read channel analytics.', ['upload_video', 'get_analytics', 'list_videos'], oauthCredential, {
    authHint: googleHint,
  }),
  // DevOps
  manifest('vercel', 'Vercel', 'DevOps', 'Deploy generated sites to Vercel (inline files, no git/CLI needed) and read project/deployment status.', ['create_deployment', 'get_deployment', 'list_deployments', 'list_projects'], bearerCredential, {
    docsUrl: 'https://vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment',
    authHint: 'Access token from Vercel → Account Settings → Tokens.',
  }),
  manifest('jenkins', 'Jenkins', 'DevOps', 'Trigger builds and read job status.', ['trigger_build', 'get_build_status', 'list_jobs'], { type: 'api_key', fields: ['baseUrl', 'username', 'apiToken'] }, {
    docsUrl: 'https://www.jenkins.io/doc/book/using/remote-access-api/',
    authHint: 'Your Jenkins base URL, username, and an API token from Jenkins → your user → Configure → API Token.',
  }),
  manifest('circleci', 'CircleCI', 'DevOps', 'Trigger pipelines and read job status.', ['trigger_pipeline', 'get_pipeline', 'get_job_status'], bearerCredential, {
    docsUrl: 'https://circleci.com/docs/api/v2/',
    authHint: 'Personal API token from CircleCI → User Settings → Personal API Tokens.',
  }),
  // Finance
  manifest('chargebee', 'Chargebee', 'Payments', 'Create subscriptions, customers, and invoices.', ['create_subscription', 'create_customer', 'create_invoice'], { type: 'api_key', fields: ['site', 'apiKey'] }, {
    authHint: 'Your site name and an API key from Chargebee → Settings → Configure Chargebee → API Keys.',
  }),
  manifest('quickbooks', 'QuickBooks', 'Payments', 'Create invoices, customers, and read reports.', ['create_invoice', 'create_customer', 'get_report'], { type: 'api_key', fields: ['realmId', 'accessToken', 'refreshToken'] }, {
    docsUrl: 'https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/account',
    authHint: 'Realm ID + access/refresh tokens — register an app at developer.intuit.com and run its OAuth flow once (e.g. via the Intuit OAuth Playground) to obtain these.',
  }),
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
  opts: ManifestOpts = {},
): ManifestSeed {
  return {
    service, name, category, description, operations, credentialSchema,
    docsUrl: opts.docsUrl, authHint: opts.authHint, icon: service, runtime: opts.runtime,
  };
}


