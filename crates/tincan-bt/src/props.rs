//! Plain-data D-Bus property values, so parsing can be tested without a bus.

use std::collections::BTreeMap;

use serde::Serialize;

/// A D-Bus property value, reduced to the shapes BlueZ uses for the
/// properties Tincan reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PropValue {
    Bool(bool),
    Int(i64),
    Str(String),
    StrList(Vec<String>),
    /// Anything else (dicts, byte arrays, structures). Kept so a property's
    /// presence is visible, but not interpreted.
    Other,
}

/// Property name → value (one interface's `GetAll`).
pub type Props = BTreeMap<String, PropValue>;

pub fn get<'a>(props: &'a Props, key: &str) -> Option<&'a PropValue> {
    props.get(key)
}

pub fn get_str(props: &Props, key: &str) -> Option<String> {
    match get(props, key)? {
        PropValue::Str(s) => Some(s.clone()),
        _ => None,
    }
}

pub fn get_bool(props: &Props, key: &str) -> bool {
    matches!(get(props, key), Some(PropValue::Bool(true)))
}

pub fn get_u32(props: &Props, key: &str) -> Option<u32> {
    match get(props, key)? {
        PropValue::Int(n) => u32::try_from(*n).ok(),
        _ => None,
    }
}

pub fn get_list(props: &Props, key: &str) -> Vec<String> {
    match get(props, key) {
        Some(PropValue::StrList(list)) => list.clone(),
        _ => Vec::new(),
    }
}

pub fn get_u64(props: &Props, key: &str) -> Option<u64> {
    match get(props, key)? {
        PropValue::Int(n) => u64::try_from(*n).ok(),
        _ => None,
    }
}

/// Converts a `a{sv}` reply into [`Props`].
pub fn props_from_zbus<'a>(
    props: impl IntoIterator<Item = (&'a String, &'a zbus::OwnedVariant)>,
) -> Props {
    props
        .into_iter()
        .map(|(key, value)| (key.clone(), prop_from_variant(value)))
        .collect()
}

pub fn prop_from_variant(value: &zbus::Variant<'_>) -> PropValue {
    use zbus::Variant as V;
    match value {
        V::Bool(b) => PropValue::Bool(*b),
        V::U8(n) => PropValue::Int(i64::from(*n)),
        V::I16(n) => PropValue::Int(i64::from(*n)),
        V::U16(n) => PropValue::Int(i64::from(*n)),
        V::I32(n) => PropValue::Int(i64::from(*n)),
        V::U32(n) => PropValue::Int(i64::from(*n)),
        V::I64(n) => PropValue::Int(*n),
        V::U64(n) => i64::try_from(*n).map_or(PropValue::Other, PropValue::Int),
        V::Str(s) => PropValue::Str(s.to_string()),
        V::ObjectPath(p) => PropValue::Str(p.as_str().to_string()),
        V::Variant(inner) => prop_from_variant(inner),
        V::Array(array) => {
            let mut items = Vec::with_capacity(array.len());
            for item in array.inner() {
                match item {
                    V::Str(s) => items.push(s.to_string()),
                    V::ObjectPath(p) => items.push(p.as_str().to_string()),
                    _ => return PropValue::Other,
                }
            }
            PropValue::StrList(items)
        }
        _ => PropValue::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_zbus_variants() {
        assert_eq!(
            prop_from_variant(&zbus::Variant::Bool(true)),
            PropValue::Bool(true)
        );
        assert_eq!(prop_from_variant(&zbus::Variant::U32(7)), PropValue::Int(7));
        assert_eq!(
            prop_from_variant(&zbus::Variant::from("hci0")),
            PropValue::Str("hci0".into())
        );
        let list = zbus::Variant::from(vec!["a", "b"]);
        assert_eq!(
            prop_from_variant(&list),
            PropValue::StrList(vec!["a".into(), "b".into()])
        );
    }
}
