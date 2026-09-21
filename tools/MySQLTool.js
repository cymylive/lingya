const { Tool, ToolResult } = require('./ToolRegistry');
const mysql = require('mysql2/promise');

/**
 * MySQL 工具 - 执行 SQL 查询或写操作。
 * AI 直接传完整连接参数（host/port/user/password/database）+ SQL。
 * 返回纯文本表格（SELECT）或执行统计（INSERT/UPDATE/DELETE/DDL）。
 */
class MySQLTool extends Tool {
  constructor() {
    super(
      'mysql',
      '执行 MySQL SQL 语句。传入连接参数（host/port/user/password/database）和 sql。SELECT/SHOW/DESCRIBE/EXPLAIN 返回纯文本表格，写操作返回 affectedRows。',
      {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'MySQL 主机地址，默认 localhost' },
          port: { type: 'number', description: 'MySQL 端口，默认 3306' },
          user: { type: 'string', description: '用户名' },
          password: { type: 'string', description: '密码' },
          database: { type: 'string', description: '数据库名' },
          sql: { type: 'string', description: '要执行的 SQL 语句' },
          limit: { type: 'number', description: 'SELECT 返回行数上限，默认 100，最大 1000' }
        },
        required: ['user', 'database', 'sql'],
        additionalProperties: false
      },
      'mysql(options)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:mysql',
      order: 107,
      text: '使用 mysql 工具执行 MySQL SQL 语句。传入 host/port/user/password/database 和 sql。SELECT/SHOW/DESCRIBE/EXPLAIN 返回纯文本表格，写操作返回 affectedRows。'
    };
  }

  async execute(params) {
    const {
      host = 'localhost',
      port = 3306,
      user,
      password = '',
      database,
      sql,
      limit = 100
    } = params;

    try {
      if (!user || typeof user !== 'string') {
        return ToolResult.error('user 不能为空');
      }
      if (!database || typeof database !== 'string') {
        return ToolResult.error('database 不能为空');
      }
      if (!sql || typeof sql !== 'string') {
        return ToolResult.error('sql 不能为空');
      }

      const safeLimit = Math.min(Math.max(1, limit || 100), 1000);
      const startTime = Date.now();

      const connection = await mysql.createConnection({
        host,
        port: Number(port) || 3306,
        user,
        password,
        database,
        connectTimeout: 10000
      });

      try {
        const trimmedSql = sql.trim();

        // 判断是否查询类语句
        const isQuery = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(trimmedSql);
        // 只有 SELECT 才自动加 LIMIT；SHOW/DESCRIBE/EXPLAIN 不支持 LIMIT
        const isSelect = /^SELECT\b/i.test(trimmedSql);

        if (isQuery) {
          let finalSql = trimmedSql;
          if (isSelect && !/\bLIMIT\b/i.test(finalSql)) {
            finalSql = finalSql.replace(/;?\s*$/, '') + ' LIMIT ' + safeLimit;
          }

          const [rows, fields] = await connection.query(finalSql);

          const elapsed = Date.now() - startTime;
          const actualRows = Array.isArray(rows) ? rows.length : 0;

          // 渲染表格
          let output = '# 查询成功（rows=' + actualRows + ', elapsed=' + elapsed + 'ms）\n\n';

          if (actualRows === 0) {
            output += '(no rows)';
          } else {
            const columns = Array.isArray(fields) ? fields.map(f => f.name) : Object.keys(rows[0]);
            output += renderTable(columns, rows);
          }

          return ToolResult.success(output);
        } else {
          // 写操作或 DDL
          const [result] = await connection.query(trimmedSql);

          const elapsed = Date.now() - startTime;
          const affectedRows = result.affectedRows || 0;
          const insertId = result.insertId || 0;
          const changedRows = result.changedRows !== undefined ? result.changedRows : affectedRows;

          let output = '# 执行成功（affectedRows=' + affectedRows + ', elapsed=' + elapsed + 'ms）';
          if (insertId > 0) {
            output += '\ninsertId: ' + insertId;
          }
          if (changedRows !== affectedRows) {
            output += '\nchangedRows: ' + changedRows;
          }

          return ToolResult.success(output);
        }
      } finally {
        await connection.end().catch(() => {});
      }
    } catch (err) {
      const msg = extractErrorMessage(err);
      return ToolResult.error('MySQL 执行失败: ' + msg);
    }
  }
}

/**
 * 渲染纯文本表格
 */
function extractErrorMessage(err) {
  if (!err) return '未知错误';
  if (err.errors && Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map(e => e.message || String(e)).join('; ');
  }
  if (err.code && err.message) {
    return err.code + ': ' + err.message;
  }
  return err.message || String(err);
}

function renderTable(columns, rows) {
  const header = columns.map(String);
  const lines = [];
  lines.push('| ' + header.join(' | ') + ' |');
  lines.push('|' + header.map(() => '---').join('|') + '|');

  for (const row of rows) {
    const values = columns.map(col => {
      const v = row[col];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    });
    lines.push('| ' + values.join(' | ') + ' |');
  }

  return lines.join('\n');
}

module.exports = { MySQLTool, renderTable };
