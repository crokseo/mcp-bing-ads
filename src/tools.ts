import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const tools: Tool[] = [
  {
    name: "bing_ads_get_client_context",
    description: "Get the current client context and health status based on working directory. Call this first to confirm which Bing Ads account you're working with.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        working_directory: {
          type: "string",
          description: "The current working directory",
        },
      },
      required: ["working_directory"],
    },
  },
  {
    name: "bing_ads_list_campaigns",
    description: "List all campaigns for the current client's Bing/Microsoft Advertising account, including campaign name, status, budget, and type.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "The account ID (uses context if not provided)",
        },
      },
    },
  },
  {
    name: "bing_ads_get_campaign_performance",
    description: "Get campaign performance metrics (impressions, clicks, CTR, CPC, spend, conversions, revenue) for a date range.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string" },
        start_date: { type: "string", description: "Start date YYYY-MM-DD" },
        end_date: { type: "string", description: "End date YYYY-MM-DD" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "bing_ads_list_ad_groups",
    description: "List ad groups within a specific campaign, including ad group name and status.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string" },
        campaign_id: { type: "string", description: "The numeric string campaign ID to list ad groups for" },
      },
      required: ["campaign_id"],
    },
  },
  {
    name: "bing_ads_keyword_performance",
    description: "Get keyword performance report with metrics including impressions, clicks, cost, conversions, quality score. Optionally filter by campaign.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string" },
        start_date: { type: "string", description: "Start date YYYY-MM-DD" },
        end_date: { type: "string", description: "End date YYYY-MM-DD" },
        campaign_ids: { type: "array", items: { type: "string" }, description: "Filter by numeric string campaign IDs" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "bing_ads_search_term_report",
    description: "Get search term report showing actual search queries that triggered ads, with matched keywords and performance metrics.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string" },
        start_date: { type: "string", description: "Start date YYYY-MM-DD" },
        end_date: { type: "string", description: "End date YYYY-MM-DD" },
        campaign_ids: { type: "array", items: { type: "string" }, description: "Filter by numeric string campaign IDs" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "bing_ads_pause_keywords",
    description: "Pause one or more keywords by setting their status to Paused. Requires account ID, ad group ID, and keyword IDs.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (REQUIRED for write operations)" },
        ad_group_id: { type: "string", description: "The ad group containing the keywords" },
        keyword_ids: { type: "array", items: { type: "string" }, description: "Array of keyword IDs to pause" },
      },
      required: ["account_id", "ad_group_id", "keyword_ids"],
    },
  },
  {
    name: "bing_ads_list_shared_entities",
    description: "List shared negative keyword lists (SharedEntity type) for the account. Returns list IDs and names needed for adding negatives.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The account ID (uses context if not provided)" },
        entity_type: { type: "string", description: "Entity type, defaults to NegativeKeywordList", default: "NegativeKeywordList" },
      },
    },
  },
  {
    name: "bing_ads_get_shared_list_items",
    description: "Get the negative keywords held in a shared negative keyword list. Use this to audit what a list actually blocks — bing_ads_list_shared_entities returns only an item count. Call it first to get list IDs.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The account ID (uses context if not provided)" },
        shared_list_id: { type: "string", description: "The shared list ID to read items from" },
        shared_list_type: { type: "string", description: "Shared list type, defaults to NegativeKeywordList", default: "NegativeKeywordList" },
      },
      required: ["shared_list_id"],
    },
  },
  {
    name: "bing_ads_get_shared_entity_associations",
    description: "Get the campaigns a shared negative keyword list is attached to. Use this to detect a list attached to the very campaign built to target those terms, which silently blocks its own keywords. bing_ads_list_shared_entities returns only an AssociationCount, not which campaigns.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The account ID (uses context if not provided)" },
        shared_entity_ids: {
          type: "array",
          items: { type: "string" },
          description: "One or more shared list IDs. The API allows one per call, so several ids are fanned out and merged automatically.",
        },
        entity_type: { type: "string", description: "What the list is attached TO, defaults to Campaign", default: "Campaign" },
        shared_entity_type: { type: "string", description: "What the list IS, defaults to NegativeKeywordList", default: "NegativeKeywordList" },
      },
      required: ["shared_entity_ids"],
    },
  },
  {
    name: "bing_ads_add_shared_negatives",
    description: "Add negative keywords to a shared negative keyword list. Use phrase match by default (wrap in quotes). Call bing_ads_list_shared_entities first to get list IDs.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (REQUIRED for write operations)" },
        shared_list_id: { type: "string", description: "The shared negative keyword list ID to add negatives to" },
        keywords: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The negative keyword text" },
              match_type: { type: "string", enum: ["Exact", "Phrase"], description: "Match type (default: Phrase)" },
            },
            required: ["text"],
          },
          description: "Array of negative keywords to add",
        },
      },
      required: ["account_id", "shared_list_id", "keywords"],
    },
  },
  {
    name: "bing_ads_update_campaign_budget",
    description: "Update a campaign's daily budget amount. Use bing_ads_list_campaigns first to get the campaign ID and current budget.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (REQUIRED for write operations)" },
        campaign_id: { type: "string", description: "The numeric string campaign ID to update" },
        daily_budget: { type: "number", description: "New daily budget in dollars (e.g. 50.00 for $50/day)" },
      },
      required: ["account_id", "campaign_id", "daily_budget"],
    },
  },
  {
    name: "bing_ads_update_ad_group_cpc_bid",
    description:
      "Update an ad group's max CPC bid (CpcBid.Amount). Max CPC lives at AD GROUP level in Bing — " +
      "there is no campaign-level max CPC — so changing 'the campaign's max CPC' means calling this " +
      "once per ad group. Use bing_ads_list_ad_groups first to get the ad group IDs and their current " +
      "bids. NOTE: if the ad group's BiddingScheme is EnhancedCpc (or any auto strategy), this value " +
      "is a BASE bid that Bing adjusts up and down, not a hard ceiling — and lowering it reduces ad " +
      "rank, so it cuts volume as well as cost.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (REQUIRED for write operations)" },
        campaign_id: { type: "string", description: "The numeric string campaign ID the ad group belongs to" },
        ad_group_id: { type: "string", description: "The numeric string ad group ID to update" },
        cpc_bid: { type: "number", description: "New max CPC bid in dollars (e.g. 10.00 for $10)" },
        expected_current_bid: {
          type: "number",
          description:
            "The ad group's CURRENT CpcBid.Amount as you last read it. The call is refused if the live " +
            "bid differs, so a change computed against stale state cannot silently overwrite someone " +
            "else's. Read it from bing_ads_list_ad_groups; do not guess.",
        },
      },
      required: ["account_id", "campaign_id", "ad_group_id", "cpc_bid", "expected_current_bid"],
    },
  },
  {
    name: "bing_ads_campaign_query",
    description: "Read any Campaign Management v13 resource through its REST query endpoint (read-only: the path must end in a segment starting with \"Query\"). Covers what the dedicated tools do not: ads (/Ads/QueryByAdGroupId with AdTypes [\"ResponsiveSearch\"]), targeting (/CampaignCriterions/QueryByIds with CampaignId and ONE CriterionType per call: Location, DayTime, Device, LocationIntent, Radius), ad group criterions incl. audiences (/AdGroupCriterions/QueryByIds), ad extensions (/AdExtensionIds/QueryByAccountId, /AdExtensions/QueryByIds, /AdExtensionsAssociations/QueryByEntityIds), keywords (/Keywords/QueryByAdGroupId), negative keywords (/NegativeKeywords/QueryByEntityIds), conversion goals (/ConversionGoals/QueryByIds), audiences (/Audiences/QueryByIds). Ids must be numbers in the body.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The account ID (uses context if not provided)" },
        path: { type: "string", description: "Query endpoint relative to CampaignManagement/v13, e.g. \"/Ads/QueryByAdGroupId\"" },
        body: { type: "object", description: "JSON request body, e.g. {\"AdGroupId\": 123, \"AdTypes\": [\"ResponsiveSearch\"]}" },
      },
      required: ["path"],
    },
  },
  {
    name: "bing_ads_run_report",
    description: "Run any Reporting v13 report and return its rows. Use for what the dedicated report tools do not cover: AdPerformance, AssetPerformance, GeographicPerformance, AudiencePerformance, AgeGenderAudience, AdExtensionDetail, ShareOfVoice (impression share), ConversionPerformance, AccountPerformance, AdGroupPerformance, CampaignPerformance with extra columns. Defaults to Paris time (the dedicated report tools use Pacific time).",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The account ID (uses context if not provided)" },
        report_type: { type: "string", description: "Report type, e.g. \"AdPerformance\" or \"AdPerformanceReportRequest\"" },
        columns: { type: "array", items: { type: "string" }, description: "Report columns, as named in the Reporting v13 docs for that report type" },
        start_date: { type: "string", description: "Start date YYYY-MM-DD" },
        end_date: { type: "string", description: "End date YYYY-MM-DD" },
        aggregation: { type: "string", description: "Summary (default), Daily, Weekly, Monthly, Hourly, DayOfWeek..." },
        campaign_ids: { type: "array", items: { type: "string" }, description: "Optional campaign scope" },
        time_zone: { type: "string", description: "Report time zone (default BrusselsCopenhagenMadridParis)" },
      },
      required: ["report_type", "columns", "start_date", "end_date"],
    },
  },
  {
    name: "bing_ads_set_ad_schedule",
    description: "Replace the ad schedule (DayTime criterions) of one or more campaigns with the given plages. Days without any plage get no delivery. Only DayTime criterions of the named campaigns are touched. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        campaign_ids: { type: "array", items: { type: "string" }, description: "Campaigns that get this exact schedule" },
        plages: { type: "array", description: "Complete target schedule. Empty array = remove the schedule (24/7), only with diffusion_24_7: true", items: { type: "object", additionalProperties: false, properties: {
          jour: { type: "string", description: "lundi..dimanche or Monday..Sunday" },
          debut: { type: "string", description: "Start HH:MM, minutes 00/15/30/45" },
          fin: { type: "string", description: "End HH:MM (24:00 allowed), after debut" },
          bid_multiplier: { type: "number", description: "Bid adjustment in percent, -90 to 900 (default 0)" },
        }, required: ["jour", "debut", "fin"] } },
        diffusion_24_7: { type: "boolean", description: "Required to confirm that an empty plages means 24/7" },
      },
      required: ["campaign_ids","plages"],
    },
  },
  {
    name: "bing_ads_set_locations",
    description: "Replace the location targeting (inclusions and exclusions) of a campaign. Only Location criterions of that campaign are touched; radius and location intent are left as they are. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        campaign_id: { type: "string" },
        inclusions: { type: "array", description: "Complete list of targeted locations. Omitted bid_multiplier keeps the current one (0 if new)", items: { type: "object", additionalProperties: false, properties: {
          location_id: { type: "string" },
          bid_multiplier: { type: "number", description: "-90 to 900" },
        }, required: ["location_id"] } },
        exclusions: { type: "array", items: { type: "string" }, description: "Complete list of excluded location ids. Omitted = current exclusions kept" },
        autoriser_cible_vide: { type: "boolean", description: "Required to allow an empty inclusions list (= all locations)" },
      },
      required: ["campaign_id","inclusions"],
    },
  },
  {
    name: "bing_ads_set_device_bid",
    description: "Set the device bid adjustments of a campaign. Omitted devices are left unchanged; -100 excludes a device. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        campaign_id: { type: "string" },
        computers: { type: "number", description: "-100 to 900" },
        smartphones: { type: "number", description: "-100 to 900" },
        tablets: { type: "number", description: "-100 to 900" },
      },
      required: ["campaign_id"],
    },
  },
  {
    name: "bing_ads_set_ad_group_status",
    description: "Set ad groups of a campaign to Active or Paused (never Deleted). Refused if the campaign would be left without any active ad group. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        campaign_id: { type: "string", description: "Campaign owning the ad groups" },
        ad_group_ids: { type: "array", items: { type: "string" } },
        statut: { type: "string", enum: ["Active", "Paused"] },
      },
      required: ["campaign_id","ad_group_ids","statut"],
    },
  },
  {
    name: "bing_ads_set_final_url_suffix",
    description: "Set the account-level final URL suffix (e.g. UTM parameters). Never touches the tracking template, which click-fraud tools such as ClickCease rely on. Warns about campaign suffixes that override it. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        valeur: { type: "string", description: "Suffix without leading ? or &, e.g. utm_source=bing&utm_medium=cpc. Empty string clears it" },
      },
      required: ["valeur"],
    },
  },
  {
    name: "bing_ads_set_bidding_strategy",
    description: "Switch campaigns to MaxConversions or MaxConversionValue, with an optional target CPA or ROAS. Refuses campaigns in a portfolio bid strategy and campaigns whose current strategy the API does not expose (it could not be restored). Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        campaign_ids: { type: "array", items: { type: "string" } },
        strategie: { type: "string", enum: ["MaxConversions", "MaxConversionValue"] },
        target_cpa: { type: "number", description: "Optional, MaxConversions only, account currency" },
        target_roas: { type: "number", description: "Optional, MaxConversionValue only, as the API expects it" },
        bidding_scheme: { type: "object", description: "Restore only: a bidding scheme taken from restore_args of a snapshot" },
      },
      required: ["campaign_ids"],
    },
  },
  {
    name: "bing_ads_add_keywords",
    description: "Add keywords to an ad group. Creation only: nothing is removed; keywords that already exist (same text and match type) are skipped. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        ad_group_id: { type: "string" },
        keywords: { type: "array", items: { type: "object", additionalProperties: false, properties: {
          text: { type: "string" },
          match_type: { type: "string", enum: ["Exact", "Phrase", "Broad"] },
          bid: { type: "number", description: "Optional keyword bid; omitted = ad group bid" },
        }, required: ["text", "match_type"] } },
      },
      required: ["ad_group_id","keywords"],
    },
  },
  {
    name: "bing_ads_add_negative_keywords",
    description: "Add negative keywords to a campaign or an ad group. Creation only; existing negatives are skipped. At ad group level, warns when a negative would block an active keyword of the group. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        niveau: { type: "string", enum: ["campaign", "ad_group"] },
        entity_id: { type: "string", description: "Campaign id or ad group id" },
        campaign_id: { type: "string", description: "Parent campaign, required when niveau is ad_group" },
        keywords: { type: "array", items: { type: "object", additionalProperties: false, properties: {
          text: { type: "string" },
          match_type: { type: "string", enum: ["Exact", "Phrase"], description: "Default Phrase" },
        }, required: ["text"] } },
      },
      required: ["niveau","entity_id","keywords"],
    },
  },
  {
    name: "bing_ads_add_responsive_search_ad",
    description: "Create a responsive search ad in an ad group. Validates 3-15 headlines of at most 30 characters, 2-4 descriptions of at most 90, paths of at most 15. Creation only. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        ad_group_id: { type: "string" },
        titres: { type: "array", description: "Headlines: strings or {texte, epingle 1-3}", items: {} },
        descriptions: { type: "array", description: "Descriptions: strings or {texte, epingle 1-2}", items: {} },
        final_url: { type: "string", description: "https:// landing page" },
        path1: { type: "string" },
        path2: { type: "string" },
      },
      required: ["ad_group_id","titres","descriptions","final_url"],
    },
  },
  {
    name: "bing_ads_set_campaign_status",
    description: "Set campaigns to Active or Paused (never Deleted). BudgetPaused counts as Active, BudgetAndManualPaused as Paused; warns when no campaign of the account would remain active. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        campaign_ids: { type: "array", items: { type: "string" } },
        statut: { type: "string", enum: ["Active", "Paused"] },
      },
      required: ["campaign_ids","statut"],
    },
  },
  {
    name: "bing_ads_set_conversion_goal",
    description: "Change only whether conversion goals feed automated bidding (ExcludeFromBidding) and/or their value. Windows, tag, URL expression and everything else are left untouched. The value is sent as a whole object, keeping the goal's currency. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        goal_ids: { type: "array", items: { type: "string" } },
        exclude_from_bidding: { type: "boolean", description: "false = the goal counts in Conversions and in automated bidding" },
        revenue: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["FixedValue", "VariableValue", "NoValue"] },
            value: { type: "number", description: "Value per conversion (default value for VariableValue), account currency" },
          },
          required: ["type"],
        },
      },
      required: ["goal_ids"],
    },
  },
  {
    name: "bing_ads_set_ad_group_network",
    description: "Set the search network of ad groups: OwnedAndOperatedOnly (Microsoft sites only, no search partners) or OwnedAndOperatedAndSyndicatedSearch (partners included). SyndicatedSearchOnly needs autoriser_partenaires_seuls. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        campaign_id: { type: "string", description: "Campaign owning the ad groups" },
        ad_group_ids: { type: "array", items: { type: "string" } },
        reseau: { type: "string", enum: ["OwnedAndOperatedOnly", "OwnedAndOperatedAndSyndicatedSearch", "SyndicatedSearchOnly"] },
        autoriser_partenaires_seuls: { type: "boolean", description: "Required to set SyndicatedSearchOnly" },
      },
      required: ["campaign_id","ad_group_ids","reseau"],
    },
  },
  {
    name: "bing_ads_set_audience_network_bid",
    description: "Set the Microsoft Audience Network bid adjustment (AudienceAdsBidAdjustment) of a Search campaign, -100 to 900. -100 stops the campaign serving on the Audience Network. Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        campaign_id: { type: "string" },
        ajustement: { type: "integer", description: "-100 to 900; -100 excludes the Audience Network" },
      },
      required: ["campaign_id","ajustement"],
    },
  },
  {
    name: "bing_ads_add_audience_criterion",
    description: "Attach an audience (remarketing list, customer list, in-market...) to a campaign or to ad groups, in observation (bid only, multiplier, default 0) or as an exclusion. Creation only, existing associations are skipped. Refuses an observation where audiences are in Targeting mode (it would restrict delivery) unless autoriser_ciblage, and a biddable association when the other level already has one (Microsoft forbids both levels). Dry run by default: returns before/after, diff, warnings and restore_args (arguments that undo the change); confirm=true applies it after writing a snapshot, then re-reads to verify.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        account_id: { type: "string", description: "The Bing Ads account ID (required with confirm=true)" },
        confirm: { type: "boolean", description: "false (default) = dry run, read-only. true = apply; needs BING_ADS_MCP_WRITE=true, account_id and snapshot_path" },
        snapshot_path: { type: "string", description: "Absolute path of a new .json file where the current state and restore_args are saved before any change (required with confirm=true)" },
        niveau: { type: "string", enum: ["campaign", "ad_group"] },
        campaign_id: { type: "string", description: "The campaign, or the parent campaign of the ad groups" },
        ad_group_ids: { type: "array", items: { type: "string" }, description: "Required when niveau is ad_group" },
        audience_id: { type: "string" },
        mode: { type: "string", enum: ["observation", "exclusion"] },
        bid_multiplier: { type: "number", description: "Observation only, -90 to 900, default 0" },
        autoriser_ciblage: { type: "boolean", description: "Allow an observation where audiences are in Targeting mode" },
      },
      required: ["niveau","campaign_id","audience_id","mode"],
    },
  },
];
