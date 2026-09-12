//! Low-level SQLite parameter binding and row serialization helpers.
use serde_json::{Map, Number, Value};
use sqlx::query::Query;
use sqlx::sqlite::{SqliteArguments, SqliteRow};
use sqlx::{Column, Row, Sqlite, TypeInfo, ValueRef};

use super::{MAX_PARAMETERS, MAX_REQUEST_BYTES};

pub(super) fn validate_parameter_payload(parameters: &[Value], expected: usize) -> Result<(), String> {
    if parameters.len() != expected || parameters.len() > MAX_PARAMETERS {
        return Err("SessionRepository 参数数量无效".to_string());
    }
    let encoded = serde_json::to_vec(parameters)
        .map_err(|error| format!("无法编码 SessionRepository 参数：{error}"))?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("SessionRepository 参数超过 2 MiB 安全上限".to_string());
    }
    if parameters
        .iter()
        .any(|value| matches!(value, Value::Array(_) | Value::Object(_)))
    {
        return Err("SessionRepository 只接受标量绑定参数".to_string());
    }
    Ok(())
}

pub(super) fn bind_parameters<'q>(
    mut query: Query<'q, Sqlite, SqliteArguments<'q>>,
    parameters: &[Value],
) -> Result<Query<'q, Sqlite, SqliteArguments<'q>>, String> {
    for parameter in parameters {
        query = match parameter {
            Value::Null => query.bind(Option::<String>::None),
            Value::Bool(value) => query.bind(i64::from(*value)),
            Value::Number(value) => {
                if let Some(integer) = value.as_i64() {
                    query.bind(integer)
                } else if let Some(integer) = value.as_u64() {
                    let integer = i64::try_from(integer)
                        .map_err(|_| "SessionRepository 整数参数超出 SQLite 范围".to_string())?;
                    query.bind(integer)
                } else if let Some(real) = value.as_f64() {
                    query.bind(real)
                } else {
                    return Err("SessionRepository 数字参数无效".to_string());
                }
            }
            Value::String(value) => query.bind(value.clone()),
            Value::Array(_) | Value::Object(_) => {
                return Err("SessionRepository 只接受标量绑定参数".to_string())
            }
        };
    }
    Ok(query)
}

pub(super) fn row_value(row: &SqliteRow, index: usize) -> Result<Value, String> {
    let raw = row
        .try_get_raw(index)
        .map_err(|error| format!("无法读取 SessionRepository 查询结果：{error}"))?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    match raw.type_info().name() {
        "INTEGER" => row
            .try_get::<i64, _>(index)
            .map(|value| Value::Number(Number::from(value)))
            .map_err(|error| format!("无法解码 SQLite INTEGER：{error}")),
        "REAL" => {
            let value = row
                .try_get::<f64, _>(index)
                .map_err(|error| format!("无法解码 SQLite REAL：{error}"))?;
            Number::from_f64(value)
                .map(Value::Number)
                .ok_or_else(|| "SQLite REAL 不是有限数字".to_string())
        }
        "TEXT" => row
            .try_get::<String, _>(index)
            .map(Value::String)
            .map_err(|error| format!("无法解码 SQLite TEXT：{error}")),
        "BLOB" => Err("SessionRepository 查询不允许返回 BLOB".to_string()),
        kind => Err(format!(
            "SessionRepository 查询返回未知 SQLite 类型：{kind}"
        )),
    }
}

pub(super) fn serialize_row(row: &SqliteRow) -> Result<Value, String> {
    let mut object = Map::with_capacity(row.columns().len());
    for (index, column) in row.columns().iter().enumerate() {
        object.insert(column.name().to_string(), row_value(row, index)?);
    }
    Ok(Value::Object(object))
}
