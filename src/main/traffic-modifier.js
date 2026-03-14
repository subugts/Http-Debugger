/**
 * TrafficModifier - Modify HTTP traffic on-the-fly
 * Supports adding/removing headers, changing content, redirecting requests
 */
class TrafficModifier {
  constructor() {
    this.rules = [];
  }

  getRules() {
    return this.rules;
  }

  addRule(rule) {
    rule.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    rule.enabled = rule.enabled !== false;
    rule.createdAt = new Date().toISOString();
    this.rules.push(rule);
    return rule;
  }

  updateRule(updatedRule) {
    const index = this.rules.findIndex(r => r.id === updatedRule.id);
    if (index !== -1) {
      this.rules[index] = { ...this.rules[index], ...updatedRule };
      return this.rules[index];
    }
    return null;
  }

  deleteRule(ruleId) {
    this.rules = this.rules.filter(r => r.id !== ruleId);
    return { success: true };
  }

  toggleRule(ruleId) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = !rule.enabled;
      return rule;
    }
    return null;
  }

  applyRules(session) {
    if (this.rules.length === 0) return session;

    let modified = { ...session };

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      if (!this._matchesCondition(modified, rule)) continue;

      switch (rule.type) {
        case 'add-request-header':
          modified.requestHeaders = { ...modified.requestHeaders };
          modified.requestHeaders[rule.headerName] = rule.headerValue;
          break;

        case 'remove-request-header':
          modified.requestHeaders = { ...modified.requestHeaders };
          delete modified.requestHeaders[rule.headerName];
          break;

        case 'add-response-header':
          modified.responseHeaders = { ...modified.responseHeaders };
          modified.responseHeaders[rule.headerName] = rule.headerValue;
          break;

        case 'remove-response-header':
          modified.responseHeaders = { ...modified.responseHeaders };
          delete modified.responseHeaders[rule.headerName];
          break;

        case 'modify-request-body':
          if (modified.requestBody && rule.searchText) {
            modified.requestBody = modified.requestBody.replace(
              new RegExp(rule.searchText, 'g'),
              rule.replaceText || ''
            );
          }
          break;

        case 'modify-response-body':
          if (modified.responseBody && rule.searchText) {
            modified.responseBody = modified.responseBody.replace(
              new RegExp(rule.searchText, 'g'),
              rule.replaceText || ''
            );
          }
          break;

        case 'redirect':
          if (rule.redirectUrl) {
            modified.url = modified.url.replace(rule.matchUrl || modified.url, rule.redirectUrl);
            modified.isRedirected = true;
            modified.originalUrl = session.url;
          }
          break;

        case 'set-status-code':
          if (rule.statusCode) {
            modified.statusCode = parseInt(rule.statusCode);
          }
          break;

        case 'delay':
          if (rule.delayMs) {
            modified.duration = (modified.duration || 0) + parseInt(rule.delayMs);
          }
          break;

        case 'block':
          modified.statusCode = 403;
          modified.statusMessage = 'Blocked by HTTP Debugger Rule';
          modified.responseBody = 'Request blocked by traffic rule';
          modified.isBlocked = true;
          break;
      }
    }

    return modified;
  }

  _matchesCondition(session, rule) {
    if (!rule.condition || rule.condition === 'all') return true;

    const value = this._getConditionValue(session, rule.conditionField);
    if (value === null) return false;

    switch (rule.condition) {
      case 'contains':
        return value.toString().toLowerCase().includes((rule.conditionValue || '').toLowerCase());
      case 'equals':
        return value.toString().toLowerCase() === (rule.conditionValue || '').toLowerCase();
      case 'starts-with':
        return value.toString().toLowerCase().startsWith((rule.conditionValue || '').toLowerCase());
      case 'ends-with':
        return value.toString().toLowerCase().endsWith((rule.conditionValue || '').toLowerCase());
      case 'regex':
        try {
          return new RegExp(rule.conditionValue, 'i').test(value.toString());
        } catch (e) {
          return false;
        }
      default:
        return true;
    }
  }

  _getConditionValue(session, field) {
    switch (field) {
      case 'url': return session.url;
      case 'host': return session.host;
      case 'path': return session.path;
      case 'method': return session.method;
      case 'status': return session.statusCode?.toString();
      case 'content-type': return session.responseHeaders?.['content-type'];
      default: return session.url;
    }
  }
}

module.exports = TrafficModifier;
