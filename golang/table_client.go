// Package an5adapters provides TableClient for dynamic map-based table queries.
package an5adapters

import (
	"context"
	"fmt"
	"strings"

	"an5adapters/base"
)

// TableClient provides table-scoped CRUD, aggregate, and vector search operations for dynamic map rows.
type TableClient struct {
	Adapter   *An5Adapter
	TableName string
}

// Table returns a TableClient for the specified table name.
func (a *An5Adapter) Table(tableName string) *TableClient {
	return &TableClient{
		Adapter:   a,
		TableName: tableName,
	}
}

// FindMany fetches rows matching where clause.
func (t *TableClient) FindMany(ctx context.Context, whereClause string, args ...interface{}) ([]map[string]interface{}, error) {
	query := fmt.Sprintf("SELECT * FROM %s", base.QuoteTable(t.TableName, t.Adapter.Dialect))
	if strings.TrimSpace(whereClause) != "" {
		query += " WHERE " + whereClause
	}
	return t.Adapter.QueryRaw(ctx, query, args...)
}

// FindFirst fetches first row matching where clause.
func (t *TableClient) FindFirst(ctx context.Context, whereClause string, args ...interface{}) (map[string]interface{}, error) {
	rows, err := t.FindMany(ctx, whereClause, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// Count returns total row count matching where clause.
func (t *TableClient) Count(ctx context.Context, whereClause string, args ...interface{}) (int64, error) {
	query := fmt.Sprintf("SELECT COUNT(*) AS cnt FROM %s", base.QuoteTable(t.TableName, t.Adapter.Dialect))
	if strings.TrimSpace(whereClause) != "" {
		query += " WHERE " + whereClause
	}
	rows, err := t.Adapter.QueryRaw(ctx, query, args...)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	if cnt, ok := rows[0]["cnt"].(int64); ok {
		return cnt, nil
	}
	return 0, nil
}

// Create inserts one map row and returns the affected row count.
func (t *TableClient) Create(ctx context.Context, data map[string]interface{}) (int64, error) {
	if len(data) == 0 {
		return 0, fmt.Errorf("create requires at least one field")
	}

	columns := make([]string, 0, len(data))
	placeholders := make([]string, 0, len(data))
	values := make([]interface{}, 0, len(data))
	for col, val := range data {
		columns = append(columns, base.QuoteIdentifier(col, t.Adapter.Dialect))
		placeholders = append(placeholders, placeholder(t.Adapter.Dialect, len(values)+1))
		values = append(values, val)
	}

	query := fmt.Sprintf(
		"INSERT INTO %s (%s) VALUES (%s)",
		base.QuoteTable(t.TableName, t.Adapter.Dialect),
		strings.Join(columns, ", "),
		strings.Join(placeholders, ", "),
	)
	return t.Adapter.ExecuteRaw(ctx, query, values...)
}

// CreateMany inserts rows one by one and optionally skips duplicate errors.
func (t *TableClient) CreateMany(ctx context.Context, rows []map[string]interface{}, skipDuplicates bool) (int64, error) {
	var count int64
	for _, row := range rows {
		affected, err := t.Create(ctx, row)
		if err != nil {
			if skipDuplicates {
				continue
			}
			return count, err
		}
		count += affected
	}
	return count, nil
}

// UpdateMany updates rows matching where clause and returns affected row count.
func (t *TableClient) UpdateMany(ctx context.Context, data map[string]interface{}, whereClause string, args ...interface{}) (int64, error) {
	if len(data) == 0 {
		return 0, nil
	}

	sets := make([]string, 0, len(data))
	values := make([]interface{}, 0, len(data)+len(args))
	for col, val := range data {
		sets = append(sets, fmt.Sprintf("%s = %s", base.QuoteIdentifier(col, t.Adapter.Dialect), placeholder(t.Adapter.Dialect, len(values)+1)))
		values = append(values, val)
	}
	values = append(values, args...)

	query := fmt.Sprintf("UPDATE %s SET %s", base.QuoteTable(t.TableName, t.Adapter.Dialect), strings.Join(sets, ", "))
	if strings.TrimSpace(whereClause) != "" {
		query += " WHERE " + whereClause
	}
	return t.Adapter.ExecuteRaw(ctx, query, values...)
}

// Update is a convenience alias for UpdateMany.
func (t *TableClient) Update(ctx context.Context, data map[string]interface{}, whereClause string, args ...interface{}) (int64, error) {
	return t.UpdateMany(ctx, data, whereClause, args...)
}

// DeleteMany deletes rows matching where clause and returns affected row count.
func (t *TableClient) DeleteMany(ctx context.Context, whereClause string, args ...interface{}) (int64, error) {
	query := fmt.Sprintf("DELETE FROM %s", base.QuoteTable(t.TableName, t.Adapter.Dialect))
	if strings.TrimSpace(whereClause) != "" {
		query += " WHERE " + whereClause
	}
	return t.Adapter.ExecuteRaw(ctx, query, args...)
}

// Delete is a convenience alias for DeleteMany.
func (t *TableClient) Delete(ctx context.Context, whereClause string, args ...interface{}) (int64, error) {
	return t.DeleteMany(ctx, whereClause, args...)
}

// AggregateOptions defines aggregation operations keyed by output alias.
// Example: map[string]string{"totalAmount": "SUM(amount)", "avgAge": "AVG(age)"}
type AggregateOptions map[string]string

// Aggregate executes aggregation queries (SUM, AVG, MIN, MAX, COUNT) and returns a single row result.
func (t *TableClient) Aggregate(ctx context.Context, aggregations AggregateOptions, whereClause string, args ...interface{}) (map[string]interface{}, error) {
	if len(aggregations) == 0 {
		return map[string]interface{}{}, nil
	}
	var selects []string
	for alias, expr := range aggregations {
		selects = append(selects, fmt.Sprintf("%s AS %s", expr, base.QuoteIdentifier(alias, t.Adapter.Dialect)))
	}
	query := fmt.Sprintf("SELECT %s FROM %s", strings.Join(selects, ", "), base.QuoteTable(t.TableName, t.Adapter.Dialect))
	if strings.TrimSpace(whereClause) != "" {
		query += " WHERE " + whereClause
	}
	rows, err := t.Adapter.QueryRaw(ctx, query, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// GroupBy executes a GROUP BY query and returns grouped result rows.
// groupFields: list of column names to group by.
// aggregations: additional aggregation expressions (e.g., map[string]string{"count": "COUNT(*)"}).
func (t *TableClient) GroupBy(ctx context.Context, groupFields []string, aggregations AggregateOptions, whereClause string, args ...interface{}) ([]map[string]interface{}, error) {
	if len(groupFields) == 0 {
		return nil, fmt.Errorf("groupBy requires at least one group field")
	}
	var quotedGroups []string
	for _, f := range groupFields {
		quotedGroups = append(quotedGroups, base.QuoteIdentifier(f, t.Adapter.Dialect))
	}

	selects := make([]string, 0, len(quotedGroups)+len(aggregations))
	selects = append(selects, quotedGroups...)
	for alias, expr := range aggregations {
		selects = append(selects, fmt.Sprintf("%s AS %s", expr, base.QuoteIdentifier(alias, t.Adapter.Dialect)))
	}

	query := fmt.Sprintf(
		"SELECT %s FROM %s",
		strings.Join(selects, ", "),
		base.QuoteTable(t.TableName, t.Adapter.Dialect),
	)
	if strings.TrimSpace(whereClause) != "" {
		query += " WHERE " + whereClause
	}
	query += " GROUP BY " + strings.Join(quotedGroups, ", ")

	return t.Adapter.QueryRaw(ctx, query, args...)
}

// VectorSearch ranks table rows by vector distance using native SQL or fallback.
func (t *TableClient) VectorSearch(ctx context.Context, vector []float64, take int, whereClause string, vectorField string, distanceMetric string, args ...interface{}) ([]map[string]interface{}, error) {
	return t.Adapter.VectorSearch(ctx, t.TableName, vector, take, whereClause, vectorField, distanceMetric, args...)
}

func placeholder(dialect base.Dialect, index int) string {
	if dialect == base.DialectPostgres {
		return fmt.Sprintf("$%d", index)
	}
	return "?"
}
