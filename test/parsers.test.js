// Pure-function tests for the order/tracking parsers and the shexp68 prefill.
// Fixtures are synthetic — never paste real captures from data/raw/ here (they hold
// order numbers, addresses and tracking numbers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as jd from '../src/scrapers/jd.js';
import * as taobao from '../src/scrapers/taobao.js';
import * as shexp68 from '../src/forwarders/shexp68.js';
import * as config from '../src/config.js';

test('jd.parseOrderListJson maps pcorder_center_list orders', () => {
  const body = JSON.stringify({ data: { orderList: [{
    orderId: 1001, dateSubmit: '2026-01-02 03:04:05', parentId: '0',
    statusInfo: { orderStateName: '等待收货' }, itemPayInfo: { shouldPay: 59.9 },
    shopInfo: { shopName: 'Demo Shop' }, consigneeInfo: { customerName: 'Tester' },
    itemDetail: { itemUrl: '//details.jd.com/normal/item.action?orderid=1001&PassKey=x' },
    wareList: [{ name: 'Widget', num: '2', productId: 555 }],
  }] } });
  const [o] = jd.parseOrderListJson(body);
  assert.equal(o.orderId, '1001');
  assert.equal(o.status, '等待收货');
  assert.equal(o.amount, 59.9);
  assert.equal(o.parentOrderId, null);
  assert.equal(o.detailUrl, 'https://details.jd.com/normal/item.action?orderid=1001&PassKey=x');
  assert.deepEqual(o.items, [{ name: 'Widget', qty: 2, skuId: '555', unitPrice: null }]);
});

test('jd.parseOrderListJson tolerates junk', () => {
  assert.deepEqual(jd.parseOrderListJson('not json'), []);
  assert.deepEqual(jd.parseOrderListJson('{"data":{}}'), []);
});

test('jd.parseTrace picks the first package and the order id', () => {
  const body = JSON.stringify({ data: { orderTrackGroupInfoList: [
    { shipId: 'SF000000001', thirdName: '顺丰速运', orderTrackInfoList: [{ id: 1001 }] },
    { shipId: 'YT000000002', thirdName: '圆通速递' },
  ] } });
  const t = jd.parseTrace(body);
  assert.equal(t.orderId, '1001');
  assert.equal(t.trackingNo, 'SF000000001');
  assert.equal(t.carrier, '顺丰速运');
  assert.equal(t.packages.length, 2);
  assert.equal(jd.parseTrace('{"data":{"orderTrackGroupInfoList":[]}}'), null);
});

test('taobao.unwrapMtop strips JSONP and passes plain JSON through', () => {
  assert.deepEqual(taobao.unwrapMtop('mtopjsonp3({"a":1})'), { a: 1 });
  assert.deepEqual(taobao.unwrapMtop(' {"a":2} '), { a: 2 });
  assert.equal(taobao.unwrapMtop('mtopjsonp3(broken'), null);
});

test('taobao.parseOrderListJson parses the queryboughtlistV2 hierarchy', () => {
  const comp = {
    shopInfo_2001: { fields: { orderId: '2001', shopName: '示例旗舰店', createTime: '2026-02-03 10:00:00',
      tradeTitle: '卖家已发货', orderDetailUrl: '//trade.tmall.com/detail/orderDetail.htm?bizOrderId=2001' } },
    orderPayment_2001: { fields: { actualFee: { value: '￥70.20' } } },
    orderItemInfo_2001_1: { fields: { orderId: '2001',
      item: { title: '牙刷', quantity: 2, itemId: 9, priceInfo: { actualTotalFee: '35.10' } } } },
  };
  const [o] = taobao.parseOrderListJson(`mtopjsonp1(${JSON.stringify({ data: { data: comp } })})`);
  assert.equal(o.orderId, '2001');
  assert.equal(o.source, 'taobao');
  assert.equal(o.status, '卖家已发货');
  assert.equal(o.amount, 70.2);
  assert.equal(o.detailUrl, 'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=2001');
  assert.deepEqual(o.items, [{ name: '牙刷', qty: 2, skuId: '9', unitPrice: 17.55 }]);
});

test('shexp68.valuesFromParcel derives unit price and a source-labelled remark', () => {
  const v = shexp68.valuesFromParcel({
    orderId: '2001', source: 'taobao', trackingNo: 'YT1',
    items: [{ name: 'A'.repeat(30), qty: 2 }, { name: 'B', qty: 1 }], amount: 30,
  });
  assert.equal(v.warehouse, config.SHEXP68_DEFAULT_WAREHOUSE);
  assert.equal(v.itemName.length, config.DECLARE_NAME_MAXLEN);
  assert.equal(v.qty, '3');
  assert.equal(v.unitPrice, '10.00');
  assert.equal(v.remark, 'TB#2001');
});

test('shexp68.valuesFromParcel prefers a known item price and defaults the name', () => {
  const v = shexp68.valuesFromParcel({ orderId: '1', items: [{ name: 'X', qty: 1, unitPrice: 8.5 }] });
  assert.equal(v.unitPrice, '8.5');
  assert.equal(v.remark, 'JD#1');
  assert.equal(shexp68.valuesFromParcel({ orderId: '2', items: [] }).itemName, '杂货');
});
