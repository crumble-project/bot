-- The Exa key became a setting of the web-search-exa plugin (docs/adr/0009-plugin-settings.md).
UPDATE `credentials` SET `key` = 'web-search-exa:api-key' WHERE `key` = 'web-search:exa-key';
