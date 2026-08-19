// Package an5adapters provides TableClient for dynamic map-based table queries.
package an5adapters

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
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

// ViewClient provides read-only view operations.
type ViewClient struct {
	table *TableClient
}

// View returns a ViewClient for the specified view name.
func (a *An5Adapter) View(viewName string) *ViewClient {
	return &ViewClient{
		table: a.Table(viewName),
	}
}

func (v *ViewClient) FindMany(ctx context.Context, args *FindManyArgs) ([]map[string]interface{}, error) {
	return v.table.FindMany(ctx, args)
}

func (v *ViewClient) FindFirst(ctx context.Context, args *FindManyArgs) (map[string]interface{}, error) {
	return v.table.FindFirst(ctx, args)
}

func (v *ViewClient) FindUnique(ctx context.Context, args *FindManyArgs) (map[string]interface{}, error) {
	return v.table.FindUnique(ctx, args)
}

func (v *ViewClient) Count(ctx context.Context, args *CountArgs) (int64, error) {
	return v.table.Count(ctx, args)
}

func (v *ViewClient) Aggregate(ctx context.Context, args *AggregateArgs) (map[string]interface{}, error) {
	return v.table.Aggregate(ctx, args)
}

func (v *ViewClient) GroupBy(ctx context.Context, args *GroupByArgs) ([]map[string]interface{}, error) {
	return v.table.GroupBy(ctx, args)
}

func (v *ViewClient) VectorSearch(ctx context.Context, args *VectorSearchArgs) ([]map[string]interface{}, error) {
	return v.table.VectorSearch(ctx, args)
}

// ─── Args types (ORM-standard structured args, mirrors TypeScript AdapterTableClient) ──

// FindManyArgs configures a FindMany / FindFirst / FindUnique query.
type FindManyArgs struct {
	Where   interface{} // map[string]interface{} ORM-style where object
	OrderBy interface{} // map[string]interface{}, []interface{}, []map[string]interface{} or string
	Skip    int
	Take    int
	Select  interface{} // []string or map[string]bool
	Include interface{} // map[string]interface{} relation keys to eager-load
}

// CountArgs configures a Count query.
type CountArgs struct {
	Where interface{}
}

// DeleteManyArgs configures a DeleteMany query.
type DeleteManyArgs struct {
	Where interface{}
}

// CreateArgs configures a Create query.
type CreateArgs struct {
	Data    map[string]interface{}
	Include interface{}
	Select  interface{}
}

// CreateManyArgs configures a CreateMany query.
type CreateManyArgs struct {
	Data           []map[string]interface{}
	SkipDuplicates bool
}

// UpdateArgs configures an Update query.
type UpdateArgs struct {
	Where   interface{}
	Data    map[string]interface{} // supports {increment,decrement,multiply,divide,set} field ops
	Include interface{}
	Select  interface{}
}

// UpdateManyArgs configures an UpdateMany query.
type UpdateManyArgs struct {
	Where interface{}
	Data  map[string]interface{}
}

// DeleteArgs configures a Delete query.
type DeleteArgs struct {
	Where interface{}
}

// UpsertArgs configures an Upsert query.
type UpsertArgs struct {
	Where  interface{}
	Create map[string]interface{}
	Update map[string]interface{}
}

// AggregateArgs configures an Aggregate query.
type AggregateArgs struct {
	Where interface{}
	Count interface{} // true, or object/list/array of fields to count
	Sum   interface{}
	Avg   interface{}
	Min   interface{}
	Max   interface{}
}

// GroupByArgs configures a GroupBy query.
type GroupByArgs struct {
	By      interface{} // string or []string
	Where   interface{}
	OrderBy interface{}
	Skip    int
	Take    int
	Sum     interface{}
	Avg     interface{}
	Min     interface{}
	Max     interface{}
}

// VectorSearchArgs configures a VectorSearch query.
type VectorSearchArgs struct {
	Vector         []float64
	Take           int
	Where          interface{}
	VectorField    string
	DistanceMetric string
}

func (t *TableClient) quotedTable() string {
	return base.QuoteTable(t.TableName, t.Adapter.Dialect)
}

func (t *TableClient) nolock() string {
	if t.Adapter.Dialect == base.DialectMssql {
		return " WITH (NOLOCK)"
	}
	return ""
}

func (t *TableClient) placeholders(count int) string {
	phs := make([]string, count)
	offset := 0
	for i := 0; i < count; i++ {
		phs[i] = placeholder(t.Adapter.Dialect, i+offset+1)
	}
	return strings.Join(phs, ", ")
}

// buildWhere converts an ORM-style where object into SQL clause + bound args.
func (t *TableClient) buildWhere(where interface{}) (string, []interface{}) {
	if where == nil {
		return "", nil
	}
	if m, ok := where.(map[string]interface{}); ok && m != nil {
		clause, args := base.BuildWhere(m, t.Adapter.Dialect, func(n int) string {
			return placeholder(t.Adapter.Dialect, n)
		})
		return clause, args
	}
	return "", nil
}

func (t *TableClient) orderSql(orderBy interface{}) string {
	return base.BuildOrderBy(orderBy, t.Adapter.Dialect)
}

// selectedFields extracts scalar column names from a select object ([]string or map with truthy values).
func selectedFields(selectVal interface{}) (keys []string, hasRelationSelect bool) {
	switch v := selectVal.(type) {
	case nil:
		return nil, false
	case []string:
		return append([]string{}, v...), false
	case []interface{}:
		for _, item := range v {
			if s, ok := item.(string); ok {
				keys = append(keys, s)
			}
		}
		return keys, false
	case map[string]interface{}:
		for k, val := range v {
			if b, ok := val.(bool); ok && b {
				if k == "_count" || strings.Contains(k, "_") {
					hasRelationSelect = true
				}
				keys = append(keys, k)
			}
		}
		return keys, hasRelationSelect
	case map[string]bool:
		for k, val := range v {
			if val {
				if k == "_count" || strings.Contains(k, "_") {
					hasRelationSelect = true
				}
				keys = append(keys, k)
			}
		}
		return keys, hasRelationSelect
	}
	return nil, false
}

// projectFields keeps only selected fields on a row (mirrors TypeScript projectFields).
func projectFields(row map[string]interface{}, selectVal interface{}) map[string]interface{} {
	if row == nil || selectVal == nil {
		return row
	}
	projected := map[string]interface{}{}
	truthy := func(k string, v interface{}) bool {
		switch b := v.(type) {
		case bool:
			return b
		case interface{}:
			return b != nil
		}
		return false
	}
	switch sel := selectVal.(type) {
	case []string:
		for _, k := range sel {
			if v, ok := row[k]; ok {
				projected[k] = v
			}
		}
	case []interface{}:
		for _, item := range sel {
			if k, ok := item.(string); ok {
				if v, had := row[k]; had {
					projected[k] = v
				}
			}
		}
	case map[string]interface{}:
		for k, v := range sel {
			if truthy(k, v) {
				projected[k] = row[k]
			}
		}
	case map[string]bool:
		for k, v := range sel {
			if v {
				projected[k] = row[k]
			}
		}
	default:
		return row
	}
	if rcount, ok := row["_count"]; ok {
		projected["_count"] = rcount
	}
	return projected
}

// FindMany fetches rows matching structured ORM args (where/orderBy/skip/take/select/include).
func (t *TableClient) FindMany(ctx context.Context, args *FindManyArgs) ([]map[string]interface{}, error) {
	whereCond, queryArgs := t.buildWhere(args.Where)
	order := t.orderSql(args.OrderBy)
	take := args.Take
	skip := args.Skip
	hasSkip := skip != 0

	cols := "*"
	if keys, hasRel := selectedFields(args.Select); len(keys) > 0 && !hasRel {
		quoted := make([]string, len(keys))
		for i, k := range keys {
			quoted[i] = base.QuoteIdentifier(k, t.Adapter.Dialect)
		}
		cols = strings.Join(quoted, ", ")
	}

	var query string
	switch {
	case take > 0 && !hasSkip:
		if t.Adapter.Dialect == base.DialectPostgres || t.Adapter.Dialect == base.DialectSqlite {
			query = fmt.Sprintf("SELECT %s FROM %s", cols, t.quotedTable())
			if whereCond != "" {
				query += " WHERE " + whereCond
			}
			if order != "" {
				query += " " + order
			}
			query += fmt.Sprintf(" LIMIT %d", take)
		} else {
			query = fmt.Sprintf("SELECT TOP (%d) %s FROM %s%s", take, cols, t.quotedTable(), t.nolock())
			if whereCond != "" {
				query += " WHERE " + whereCond
			}
			if order != "" {
				query += " " + order
			}
		}
	case hasSkip:
		if t.Adapter.Dialect == base.DialectPostgres || t.Adapter.Dialect == base.DialectSqlite {
			query = fmt.Sprintf("SELECT %s FROM %s", cols, t.quotedTable())
			if whereCond != "" {
				query += " WHERE " + whereCond
			}
			if order != "" {
				query += " " + order
			}
			if take > 0 {
				query += fmt.Sprintf(" LIMIT %d", take)
			} else {
				query += " LIMIT ALL"
			}
			query += fmt.Sprintf(" OFFSET %d", skip)
		} else {
			query = fmt.Sprintf("SELECT %s FROM %s%s", cols, t.quotedTable(), t.nolock())
			if whereCond != "" {
				query += " WHERE " + whereCond
			}
			if order != "" {
				query += " " + order
			} else {
				query += " ORDER BY (SELECT NULL)"
			}
			query += fmt.Sprintf(" OFFSET %d ROWS", skip)
			if take > 0 {
				query += fmt.Sprintf(" FETCH NEXT %d ROWS ONLY", take)
			}
		}
	default:
		query = fmt.Sprintf("SELECT %s FROM %s%s", cols, t.quotedTable(), t.nolock())
		if whereCond != "" {
			query += " WHERE " + whereCond
		}
		if order != "" {
			query += " " + order
		}
	}

	rows, err := t.Adapter.QueryRaw(ctx, query, queryArgs...)
	if err != nil {
		return nil, err
	}

	if args.Include != nil {
		if err := resolveIncludes(ctx, t.TableName, rows, args.Include, t.Adapter); err != nil {
			return nil, err
		}
	}
	if args.Select != nil {
		if _, hasRel := selectedFields(args.Select); hasRel {
			if err := resolveIncludes(ctx, t.TableName, rows, args.Select, t.Adapter); err != nil {
				return nil, err
			}
		}
		for i := range rows {
			rows[i] = projectFields(rows[i], args.Select)
		}
	}
	return rows, nil
}

// FindFirst fetches the first row matching structured ORM args.
func (t *TableClient) FindFirst(ctx context.Context, args *FindManyArgs) (map[string]interface{}, error) {
	if args == nil {
		args = &FindManyArgs{}
	}
	copied := *args
	copied.Take = 1
	rows, err := t.FindMany(ctx, &copied)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// FindUnique fetches a single row by its unique where criteria.
func (t *TableClient) FindUnique(ctx context.Context, args *FindManyArgs) (map[string]interface{}, error) {
	return t.FindFirst(ctx, args)
}

// Count returns total row count matching structured where args.
func (t *TableClient) Count(ctx context.Context, args *CountArgs) (int64, error) {
	var whereCond string
	var queryArgs []interface{}
	if args != nil {
		whereCond, queryArgs = t.buildWhere(args.Where)
	}
	query := fmt.Sprintf("SELECT COUNT(*) AS cnt FROM %s%s", t.quotedTable(), t.nolock())
	if whereCond != "" {
		query += " WHERE " + whereCond
	}
	rows, err := t.Adapter.QueryRaw(ctx, query, queryArgs...)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	if cnt, ok := rows[0]["cnt"].(int64); ok {
		return cnt, nil
	}
	if f, ok := rows[0]["cnt"].(float64); ok {
		return int64(f), nil
	}
	return 0, nil
}

// generateUUID returns a random UUID v4 string.
func generateUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// splitRelationWrites separates relation-write objects from scalar data using model metadata.
func splitRelationWrites(modelName string, data map[string]interface{}) (scalars map[string]interface{}, rels map[string]interface{}) {
	scalars = map[string]interface{}{}
	rels = map[string]interface{}{}
	relations := base.GetRelationsForModel(modelName)
	for k, v := range data {
		if _, isRel := relations[k]; isRel {
			rels[k] = v
		} else {
			scalars[k] = v
		}
	}
	return scalars, rels
}

// Create inserts one map row and returns the created record.
func (t *TableClient) Create(ctx context.Context, args *CreateArgs) (map[string]interface{}, error) {
	if args == nil || len(args.Data) == 0 {
		return nil, fmt.Errorf("create requires at least one field")
	}

	fields, _ := base.GetFieldsForModel(t.TableName).(map[string]interface{})
	idFieldName := ""
	if fields != nil {
		if _, has := fields["id"]; has {
			idFieldName = "id"
		} else {
			for name := range fields {
				if strings.HasSuffix(name, "_id") || strings.HasSuffix(name, "Id") || strings.ToLower(name) == "id" {
					idFieldName = name
					break
				}
			}
		}
	}
	if fdef, has := fields[idFieldName]; has && fields != nil {
		rawType := ""
		switch ft := fdef.(type) {
		case string:
			rawType = ft
		case map[string]interface{}:
			for _, key := range []string{"ts", "sql", "type"} {
				if s, ok := ft[key].(string); ok {
					rawType = s
					break
				}
			}
		}
		normalized := strings.ToLower(rawType)
		isStringType := normalized == "" || strings.Contains(normalized, "string") || strings.Contains(normalized, "uuid") || strings.Contains(normalized, "uniqueidentifier") || strings.Contains(normalized, "nvarchar") || strings.Contains(normalized, "varchar") || strings.Contains(normalized, "text")
		if idFieldName != "" && isStringType {
			if _, present := args.Data[idFieldName]; !present || args.Data[idFieldName] == nil {
				args.Data[idFieldName] = generateUUID()
			}
		}
	}

	data, relationWrites := splitRelationWrites(t.TableName, args.Data)

	var cols []string
	var vals []string
	var values []interface{}
	for col, val := range data {
		cols = append(cols, base.QuoteIdentifier(col, t.Adapter.Dialect))
		vals = append(vals, placeholder(t.Adapter.Dialect, len(values)+1))
		values = append(values, val)
	}

	if len(cols) > 0 {
		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
			t.quotedTable(), strings.Join(cols, ", "), strings.Join(vals, ", "))
		if _, err := t.Adapter.ExecuteRaw(ctx, query, values...); err != nil {
			return nil, err
		}
	}

	where := map[string]interface{}{}
	if idFieldName != "" && args.Data[idFieldName] != nil {
		where[idFieldName] = args.Data[idFieldName]
	} else {
		where = data
	}
	created, err := t.FindFirst(ctx, &FindManyArgs{Where: where})
	if err != nil || created == nil {
		return data, err
	}

	for relKey, relWrite := range relationWrites {
		relations := base.GetRelationsForModel(t.TableName)
		relation, ok := relations[relKey]
		if !ok {
			continue
		}
		rw, ok := relWrite.(map[string]interface{})
		if !ok {
			continue
		}
		if createVal, has := rw["create"]; has {
			childClient := t.Adapter.Table(relation.ModelName)
			items := normalizeItemList(createVal)
			for _, item := range items {
				if m, ok := item.(map[string]interface{}); ok && m != nil {
					merged := map[string]interface{}{}
					for k, v := range m {
						merged[k] = v
					}
					if local, ok := created[relation.LocalKey]; ok {
						merged[relation.ForeignKey] = local
					}
					if _, err := childClient.Create(ctx, &CreateArgs{Data: merged}); err != nil {
						return nil, err
					}
				}
			}
		}
	}

	if args.Include != nil {
		if err := resolveIncludes(ctx, t.TableName, []map[string]interface{}{created}, args.Include, t.Adapter); err != nil {
			return nil, err
		}
	}
	if args.Select != nil {
		if err := resolveIncludes(ctx, t.TableName, []map[string]interface{}{created}, args.Select, t.Adapter); err != nil {
			return nil, err
		}
		return projectFields(created, args.Select), nil
	}
	return created, nil
}

// normalizeItemList accepts a single map or []interface{} and returns a flat []interface{}.
func normalizeItemList(value interface{}) []interface{} {
	switch v := value.(type) {
	case []interface{}:
		return v
	case []map[string]interface{}:
		out := make([]interface{}, len(v))
		for i, m := range v {
			out[i] = m
		}
		return out
	case map[string]interface{}:
		return []interface{}{v}
	}
	return nil
}

// CreateMany inserts rows one by one and optionally skips duplicate errors.
func (t *TableClient) CreateMany(ctx context.Context, args *CreateManyArgs) (map[string]interface{}, error) {
	if args == nil {
		args = &CreateManyArgs{}
	}
	var count int64
	for _, row := range args.Data {
		_, err := t.Create(ctx, &CreateArgs{Data: row})
		if err != nil {
			if args.SkipDuplicates {
				continue
			}
			return map[string]interface{}{"count": count}, err
		}
		count++
	}
	return map[string]interface{}{"count": count}, nil
}

// appendUpdateSet handles set expressions including {increment,decrement,multiply,divide,set} field ops.
func appendUpdateSet(setParts *[]string, values *[]interface{}, col string, val interface{}, dialect base.Dialect) {
	quoted := base.QuoteIdentifier(col, dialect)
	if m, ok := val.(map[string]interface{}); ok {
		for _, op := range []string{"increment", "decrement", "multiply", "divide", "set"} {
			if opval, has := m[op]; has {
				*values = append(*values, opval)
				p := placeholder(dialect, len(*values))
				switch op {
				case "increment":
					*setParts = append(*setParts, fmt.Sprintf("%s = %s + %s", quoted, quoted, p))
				case "decrement":
					*setParts = append(*setParts, fmt.Sprintf("%s = %s - %s", quoted, quoted, p))
				case "multiply":
					*setParts = append(*setParts, fmt.Sprintf("%s = %s * %s", quoted, quoted, p))
				case "divide":
					*setParts = append(*setParts, fmt.Sprintf("%s = %s / %s", quoted, quoted, p))
				case "set":
					*setParts = append(*setParts, fmt.Sprintf("%s = %s", quoted, p))
				}
				return
			}
		}
	}
	*values = append(*values, val)
	*setParts = append(*setParts, fmt.Sprintf("%s = %s", quoted, placeholder(dialect, len(*values))))
}

// Update updates rows matching where criteria and returns the first updated record.
func (t *TableClient) Update(ctx context.Context, args *UpdateArgs) (map[string]interface{}, error) {
	if args == nil {
		return nil, fmt.Errorf("update requires args")
	}
	data, relationWrites := splitRelationWrites(t.TableName, args.Data)

	whereCond, whereArgs := t.buildWhere(args.Where)
	setParts := []string{}
	setValues := []interface{}{}
	for col, val := range data {
		appendUpdateSet(&setParts, &setValues, col, val, t.Adapter.Dialect)
	}

	if len(setParts) > 0 {
		query := fmt.Sprintf("UPDATE %s SET %s", t.quotedTable(), strings.Join(setParts, ", "))
		if whereCond != "" {
			query += " WHERE " + whereCond
		}
		allValues := append(setValues, whereArgs...)
		if _, err := t.Adapter.ExecuteRaw(ctx, query, allValues...); err != nil {
			return nil, err
		}
	}

	updated, err := t.FindFirst(ctx, &FindManyArgs{Where: args.Where})
	if err != nil || updated == nil {
		return nil, err
	}

	for relKey, relWrite := range relationWrites {
		relations := base.GetRelationsForModel(t.TableName)
		relation, ok := relations[relKey]
		if !ok {
			continue
		}
		rw, ok := relWrite.(map[string]interface{})
		if !ok {
			continue
		}
		childClient := t.Adapter.Table(relation.ModelName)
		if createVal, has := rw["create"]; has {
			for _, item := range normalizeItemList(createVal) {
				if m, ok := item.(map[string]interface{}); ok && m != nil {
					merged := map[string]interface{}{}
					for k, v := range m {
						merged[k] = v
					}
					if local, ok := updated[relation.LocalKey]; ok {
						merged[relation.ForeignKey] = local
					}
					if _, err := childClient.Create(ctx, &CreateArgs{Data: merged}); err != nil {
						return nil, err
					}
				}
			}
		}
		if updateVal, has := rw["update"]; has {
			if m, ok := updateVal.(map[string]interface{}); ok && m != nil {
				if _, err := childClient.Update(ctx, &UpdateArgs{Where: m["where"], Data: m["data"].(map[string]interface{})}); err != nil {
					return nil, err
				}
			}
		}
		if disconnectVal, has := rw["disconnect"]; has {
			if m, ok := disconnectVal.(map[string]interface{}); ok && m != nil {
				if _, err := childClient.UpdateMany(ctx, &UpdateManyArgs{Where: m, Data: map[string]interface{}{relation.ForeignKey: nil}}); err != nil {
					return nil, err
				}
			}
		}
	}

	if args.Include != nil {
		if err := resolveIncludes(ctx, t.TableName, []map[string]interface{}{updated}, args.Include, t.Adapter); err != nil {
			return nil, err
		}
	}
	if args.Select != nil {
		if err := resolveIncludes(ctx, t.TableName, []map[string]interface{}{updated}, args.Select, t.Adapter); err != nil {
			return nil, err
		}
		return projectFields(updated, args.Select), nil
	}
	return updated, nil
}

// UpdateMany updates rows matching where criteria and returns affected count.
func (t *TableClient) UpdateMany(ctx context.Context, args *UpdateManyArgs) (map[string]interface{}, error) {
	if args == nil || len(args.Data) == 0 {
		return map[string]interface{}{"count": 0}, nil
	}
	whereCond, whereArgs := t.buildWhere(args.Where)
	setParts := []string{}
	setValues := []interface{}{}
	for col, val := range args.Data {
		appendUpdateSet(&setParts, &setValues, col, val, t.Adapter.Dialect)
	}
	if len(setParts) == 0 {
		return map[string]interface{}{"count": 0}, nil
	}
	query := fmt.Sprintf("UPDATE %s SET %s", t.quotedTable(), strings.Join(setParts, ", "))
	if whereCond != "" {
		query += " WHERE " + whereCond
	}
	allValues := append(setValues, whereArgs...)
	affected, err := t.Adapter.ExecuteRaw(ctx, query, allValues...)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"count": affected}, nil
}

// DeleteMany deletes rows matching where criteria and returns affected count.
func (t *TableClient) DeleteMany(ctx context.Context, args *DeleteManyArgs) (map[string]interface{}, error) {
	whereCond, queryArgs := t.buildWhere(args.Where)
	query := fmt.Sprintf("DELETE FROM %s", t.quotedTable())
	if whereCond != "" {
		query += " WHERE " + whereCond
	}
	affected, err := t.Adapter.ExecuteRaw(ctx, query, queryArgs...)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"count": affected}, nil
}

// Delete deletes one record matching where criteria and returns the deleted record.
func (t *TableClient) Delete(ctx context.Context, args *DeleteArgs) (map[string]interface{}, error) {
	if args == nil {
		return nil, fmt.Errorf("delete requires where")
	}
	existing, err := t.FindFirst(ctx, &FindManyArgs{Where: args.Where})
	if err != nil {
		return nil, err
	}
	whereCond, queryArgs := t.buildWhere(args.Where)
	query := fmt.Sprintf("DELETE FROM %s WHERE %s", t.quotedTable(), whereCond)
	affected, err := t.Adapter.ExecuteRaw(ctx, query, queryArgs...)
	if err != nil {
		return nil, err
	}
	boolish := affected > 0
	if !boolish {
		return nil, nil
	}
	return existing, nil
}

// Upsert creates a record if none matches where, otherwise updates it.
func (t *TableClient) Upsert(ctx context.Context, args *UpsertArgs) (map[string]interface{}, error) {
	if args == nil {
		return nil, fmt.Errorf("upsert requires args")
	}
	existing, err := t.FindFirst(ctx, &FindManyArgs{Where: args.Where})
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return t.Update(ctx, &UpdateArgs{Where: args.Where, Data: args.Update})
	}
	return t.Create(ctx, &CreateArgs{Data: args.Create})
}

// AggregateOptions defines aggregation expressions keyed by output alias.
// Deprecated: use AggregateArgs with _count/_sum/_avg/_min/_max keys.
type AggregateOptions map[string]string

// Aggregate executes aggregation queries (SUM, AVG, MIN, MAX, COUNT) and returns a single row result.
func (t *TableClient) Aggregate(ctx context.Context, args *AggregateArgs) (map[string]interface{}, error) {
	if args == nil {
		args = &AggregateArgs{}
	}
	whereCond, queryArgs := t.buildWhere(args.Where)
	var aggs []string

	if args.Count != nil {
		countFields := selectedAggregateFields(args.Count)
		if len(countFields) == 0 {
			aggs = append(aggs, "COUNT(*) AS cnt_all")
		} else {
			for _, f := range countFields {
				if f != "_all" {
					aggs = append(aggs, fmt.Sprintf("COUNT(%s) AS cnt_%s", base.QuoteIdentifier(f, t.Adapter.Dialect), sanitizeParamName(f)))
				}
			}
		}
	}
	for _, aggTuple := range []struct {
		kind  string
		value interface{}
	}{
		{"SUM", args.Sum},
		{"AVG", args.Avg},
		{"MIN", args.Min},
		{"MAX", args.Max},
	} {
		for _, f := range selectedAggregateFields(aggTuple.value) {
			aggs = append(aggs, fmt.Sprintf("%s(%s) AS %s_%s", aggTuple.kind, base.QuoteIdentifier(f, t.Adapter.Dialect), strings.ToLower(aggTuple.kind), sanitizeParamName(f)))
		}
	}

	if len(aggs) == 0 {
		return nil, fmt.Errorf("aggregate requires at least one aggregator field")
	}

	query := fmt.Sprintf("SELECT %s FROM %s%s", strings.Join(aggs, ", "), t.quotedTable(), t.nolock())
	if whereCond != "" {
		query += " WHERE " + whereCond
	}
	rows, err := t.Adapter.QueryRaw(ctx, query, queryArgs...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return map[string]interface{}{}, nil
	}
	row := rows[0]

	result := map[string]interface{}{}
	if args.Count != nil {
		countFields := selectedAggregateFields(args.Count)
		allCount := numberOrZero(row["cnt_all"], row["_count"])
		result["_count"] = map[string]interface{}{"_all": allCount}
		for _, f := range countFields {
			if f == "_all" {
				continue
			}
			key := "cnt_" + sanitizeParamName(f)
			if v, ok := row[key]; ok && v != nil {
				result["_count"].(map[string]interface{})[f] = numberOrZero(v)
			} else {
				result["_count"].(map[string]interface{})[f] = allCount
			}
		}
	}
	for _, aggTuple := range []struct {
		kind  string
		value interface{}
	}{
		{"sum", args.Sum},
		{"avg", args.Avg},
		{"min", args.Min},
		{"max", args.Max},
	} {
		fields := selectedAggregateFields(aggTuple.value)
		if len(fields) == 0 {
			continue
		}
		sub := map[string]interface{}{}
		for _, f := range fields {
			key := aggTuple.kind + "_" + sanitizeParamName(f)
			if v, ok := row[key]; ok && v != nil {
				sub[f] = numberOrNil(v)
			} else {
				sub[f] = nil
			}
		}
		result["_"+aggTuple.kind] = sub
	}
	return result, nil
}

// GroupBy executes a GROUP BY query and returns grouped result rows.
func (t *TableClient) GroupBy(ctx context.Context, args *GroupByArgs) ([]map[string]interface{}, error) {
	if args == nil {
		args = &GroupByArgs{}
	}
	byFields := normalizeByFields(args.By)
	if len(byFields) == 0 {
		return nil, fmt.Errorf("groupBy requires at least one group field")
	}
	whereCond, queryArgs := t.buildWhere(args.Where)

	quotedGroups := make([]string, len(byFields))
	for i, f := range byFields {
		quotedGroups[i] = base.QuoteIdentifier(f, t.Adapter.Dialect)
	}

	aggs := []string{"COUNT(*) AS _count"}
	for _, aggTuple := range []struct {
		kind  string
		value interface{}
	}{
		{"SUM", args.Sum},
		{"AVG", args.Avg},
		{"MIN", args.Min},
		{"MAX", args.Max},
	} {
		for _, f := range selectedAggregateFields(aggTuple.value) {
			aggs = append(aggs, fmt.Sprintf("%s(%s) AS %s_%s", aggTuple.kind, base.QuoteIdentifier(f, t.Adapter.Dialect), strings.ToLower(aggTuple.kind), sanitizeParamName(f)))
		}
	}

	query := fmt.Sprintf("SELECT %s, %s FROM %s",
		strings.Join(quotedGroups, ", "), strings.Join(aggs, ", "), t.quotedTable())
	if whereCond != "" {
		query += " WHERE " + whereCond
	}
	query += " GROUP BY " + strings.Join(quotedGroups, ", ")

	order := t.orderSql(args.OrderBy)
	hasSkip := args.Skip != 0
	hasTake := args.Take > 0
	if order != "" {
		query += " " + order
	} else if hasSkip || hasTake {
		query += " ORDER BY " + strings.Join(quotedGroups, ", ")
	}
	if hasSkip || hasTake {
		skip := args.Skip
		take := args.Take
		if take <= 0 {
			take = 1
		}
		if t.Adapter.Dialect == base.DialectPostgres || t.Adapter.Dialect == base.DialectSqlite {
			if hasTake {
				query += fmt.Sprintf(" LIMIT %d", take)
			}
			query += fmt.Sprintf(" OFFSET %d", skip)
		} else {
			query += fmt.Sprintf(" OFFSET %d ROWS", skip)
			if hasTake {
				query += fmt.Sprintf(" FETCH NEXT %d ROWS ONLY", take)
			}
		}
	}

	return t.Adapter.QueryRaw(ctx, query, queryArgs...)
}

// VectorSearch ranks table rows by vector distance using native SQL or fallback.
func (t *TableClient) VectorSearch(ctx context.Context, args *VectorSearchArgs) ([]map[string]interface{}, error) {
	if args == nil {
		args = &VectorSearchArgs{}
	}
	take := args.Take
	if take <= 0 {
		take = 10
	}
	vectorField := args.VectorField
	if vectorField == "" {
		vectorField = "embedding"
	}
	distanceMetric := args.DistanceMetric
	if distanceMetric == "" {
		distanceMetric = "cosine"
	}
	whereCond, queryArgs := t.buildWhere(args.Where)
	_ = queryArgs

	clause := ""
	if whereCond != "" {
		clause = whereCond
	}
	return t.Adapter.VectorSearch(ctx, t.TableName, args.Vector, take, clause, vectorField, distanceMetric, queryArgs...)
}

// rename function resolves include object against a set of rows using relation metadata.
func resolveIncludes(ctx context.Context, modelName string, rows []map[string]interface{}, include interface{}, adapter *An5Adapter) error {
	if len(rows) == 0 || include == nil {
		return nil
	}
	modelRelations := base.GetRelationsForModel(modelName)

	includeMap := include
	switch v := include.(type) {
	case map[string]interface{}:
		includeMap = v
	case map[string]bool:
		m := map[string]interface{}{}
		for k, b := range v {
			m[k] = b
		}
		includeMap = m
	default:
		return nil
	}
	im := includeMap.(map[string]interface{})

	keys := make([]string, 0, len(im))
	for k := range im {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		val := im[key]
		if val == nil {
			continue
		}
		if b, ok := val.(bool); ok && !b {
			continue
		}

		if key == "_count" {
			for _, row := range rows {
				if row["_count"] == nil {
					row["_count"] = map[string]interface{}{}
				}
			}
			for relKey, relation := range modelRelations {
				if relation.RelationType != "many" {
					continue
				}
				uniqueKeys := uniqueSet(rows, relation.LocalKey)
				if len(uniqueKeys) > 0 {
					relClient := adapter.Table(relation.ModelName)
					related, err := relClient.FindMany(ctx, &FindManyArgs{
						Where: map[string]interface{}{relation.ForeignKey: map[string]interface{}{"in": uniqueKeys}},
					})
					if err != nil {
						return err
					}
					countMap := map[interface{}]int{}
					for _, r := range related {
						k := r[relation.ForeignKey]
						countMap[k]++
					}
					for _, row := range rows {
						k := row[relation.LocalKey]
						c := 0
						if n, ok := countMap[k]; ok {
							c = n
						}
						row["_count"].(map[string]interface{})[relKey] = c
					}
				} else {
					for _, row := range rows {
						row["_count"].(map[string]interface{})[relKey] = 0
					}
				}
			}
			continue
		}

		relation, ok := modelRelations[key]
		if !ok {
			continue
		}
		isMany := relation.RelationType == "many"
		joinKey := relation.LocalKey
		matchKey := relation.ForeignKey
		if isMany {
			joinKey = relation.LocalKey
			matchKey = relation.ForeignKey
		} else {
			joinKey = relation.ForeignKey
			matchKey = relation.LocalKey
		}
		uniqueKeys := uniqueSet(rows, joinKey)
		if len(uniqueKeys) == 0 {
			for _, row := range rows {
				if isMany {
					row[key] = []map[string]interface{}{}
				} else {
					row[key] = nil
				}
			}
			continue
		}

		subArgs := map[string]interface{}{}
		if m, ok := val.(map[string]interface{}); ok && m != nil {
			subArgs = m
		}

		subWhere := map[string]interface{}{
			matchKey: map[string]interface{}{"in": uniqueKeys},
		}
		if w, has := subArgs["where"]; has {
			if wm, ok := w.(map[string]interface{}); ok {
				for k, v := range wm {
					subWhere[k] = v
				}
			}
		}

		relClient := adapter.Table(relation.ModelName)
		related, err := relClient.FindMany(ctx, &FindManyArgs{
			Where:   subWhere,
			OrderBy: subArgs["orderBy"],
			Take:    toPositiveInt(subArgs["take"]),
			Skip:    toPositiveInt(subArgs["skip"]),
		})
		if err != nil {
			return err
		}

		if nested, has := subArgs["include"]; has {
			if err := resolveIncludes(ctx, relation.ModelName, related, nested, adapter); err != nil {
				return err
			}
		}

		outputRows := related
		if sel, has := subArgs["select"]; has {
			outputRows = make([]map[string]interface{}, len(related))
			for i, r := range related {
				outputRows[i] = projectFields(r, sel)
			}
		}

		groupMap := map[interface{}][]map[string]interface{}{}
		for i, r := range related {
			var k interface{}
			if isMany {
				k = r[relation.ForeignKey]
			} else {
				k = r[relation.LocalKey]
			}
			groupMap[k] = append(groupMap[k], outputRows[i])
		}

		for _, row := range rows {
			var k interface{}
			if isMany {
				k = row[relation.LocalKey]
			} else {
				k = row[relation.ForeignKey]
			}
			matches := groupMap[k]
			if matches == nil {
				matches = []map[string]interface{}{}
			}
			if isMany {
				row[key] = matches
			} else if len(matches) > 0 {
				row[key] = matches[0]
			} else {
				row[key] = nil
			}
		}
	}
	return nil
}

func uniqueSet(rows []map[string]interface{}, key string) []interface{} {
	seen := map[interface{}]bool{}
	var out []interface{}
	for _, r := range rows {
		v := r[key]
		if v == nil {
			continue
		}
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func toPositiveInt(v interface{}) int {
	switch n := v.(type) {
	case int:
		if n > 0 {
			return n
		}
	case int64:
		if n > 0 {
			return int(n)
		}
	case float64:
		if n > 0 {
			return int(n)
		}
	}
	return 0
}

func sanitizeParamName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	out := b.String()
	if !strings.HasPrefix(out, "_") && (out == "" || !(out[0] >= 'a' && out[0] <= 'z') && !(out[0] >= 'A' && out[0] <= 'Z')) {
		out = "p_" + out
	}
	return out
}

func selectedAggregateFields(fields interface{}) []string {
	switch v := fields.(type) {
	case nil:
		return nil
	case string:
		if v != "" {
			return []string{v}
		}
	case bool:
		return nil
	case []string:
		return append([]string{}, v...)
	case []interface{}:
		var out []string
		for _, item := range v {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	case map[string]interface{}:
		var out []string
		for f, enabled := range v {
			if b, ok := enabled.(bool); ok && b {
				out = append(out, f)
			}
		}
		sort.Strings(out)
		return out
	case map[string]bool:
		var out []string
		for f, enabled := range v {
			if enabled {
				out = append(out, f)
			}
		}
		sort.Strings(out)
		return out
	}
	return nil
}

func normalizeByFields(by interface{}) []string {
	switch v := by.(type) {
	case string:
		if v != "" {
			return []string{v}
		}
	case []string:
		var out []string
		for _, f := range v {
			if f != "" {
				out = append(out, f)
			}
		}
		return out
	case []interface{}:
		var out []string
		for _, item := range v {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func numberOrZero(values ...interface{}) float64 {
	for _, v := range values {
		switch n := v.(type) {
		case int64:
			return float64(n)
		case int:
			return float64(n)
		case float64:
			return n
		case []byte:
			var f float64
			if _, err := fmt.Sscanf(string(n), "%f", &f); err == nil {
				return f
			}
		case string:
			var f float64
			if _, err := fmt.Sscanf(n, "%f", &f); err == nil {
				return f
			}
		}
	}
	return 0
}

func numberOrNil(v interface{}) interface{} {
	if v == nil {
		return nil
	}
	return numberOrZero(v)
}

func placeholder(dialect base.Dialect, index int) string {
	if dialect == base.DialectPostgres {
		return fmt.Sprintf("$%d", index)
	}
	return "?"
}