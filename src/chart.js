(function exposeChart(root, factory) {
    const api = factory();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.Chart = api.Chart;
    }
})(typeof window !== 'undefined' ? window : globalThis, () => {

const X = 50;
const Y = 50;


let  VALUECOLOR ;

// const VALUECOLOR = {
//     buy: '#ffc8e6',
//     ask: '#b4dcc8',
//     buy1: '#ffafc8',
//     ask1: '#a0dcb4',
//     deficit: '#0000ff',
//     profit: '#ff0000',
//     hold: '#00ff00',
//     limit: '#EF2E2E'
// }

const BUYBACKGROUND = '#322810'
// const ASKBACKGROUND = '#103210'
const ASKBACKGROUND = '#103210'
const FONTCOLOR = '#7f7f7f'
class Chart {
    constructor(dom, width, height, step = 0.2, config ={}){
        const {
            barToBorder,
            barVolume,
            barWidth = 10,
            calcBarType,
            volumeScaleCount,
            volumeScaleHeight = 30,
            volumeScaleTick,
            volumeScaleType,
            volumeXOffset = 0,
            volumeYOffset = 0,
            depthRetentionMode = 'snapshot',
            historicalDepthOpacity = 0.5,
            maxHistoricalDepthEntries = 10000
        } = config
        this.ctx = dom.getContext('2d');
        this.rendered = false;
        this.barToBorder = barToBorder;
        this.barWidth =barWidth;
        this.volumeScaleHeight = volumeScaleHeight;
        this.volumeScaleType = volumeScaleType;
        this.volumeScaleCount =volumeScaleCount;
        this.volumeScaleTick = volumeScaleTick;
        this.volumeXOffset = volumeXOffset;
        this.volumeYOffset = volumeYOffset;
        this.depthRetentionMode = depthRetentionMode === 'history'
            ? 'history'
            : 'snapshot';
        const normalizedHistoricalDepthOpacity = Number(historicalDepthOpacity);
        this.historicalDepthOpacity = Number.isFinite(normalizedHistoricalDepthOpacity)
            ? Math.min(1, Math.max(0, normalizedHistoricalDepthOpacity))
            : 0.5;
        const normalizedHistoryLimit = Math.floor(Number(maxHistoricalDepthEntries));
        this.maxHistoricalDepthEntries = Number.isFinite(normalizedHistoryLimit) &&
            normalizedHistoryLimit > 0
            ? normalizedHistoryLimit
            : 10000;
        this.width = width;
        this.height = height;
        this.step = parseFloat(step);
        this.data = [];
        this.start = 0;

        this.range = this.initRange();

        this.setColor();
        const decimal = (this.step.toString().split('.')[1] || []).length;
        this.decimal = decimal;
        this.placeOrder=[];
        this.traded ={};
        this.depthRenderId = 0;
        this.depthHistorySequence = 0;
        this.buyDepthHistory = new Map();
        this.askDepthHistory = new Map();
        this.init();
    }

    static getHeight(range, value, volumeScaleHeight){
        let start = 0;
        let before = 0;
        if(value >  range[range.length - 1]){
            return volumeScaleHeight * range.length + 30
        }
        for(let i= 0; i < range.length; i++ ){
            if(value <= range[i]){
                start = start + ((value-before) / (range[i]-before)) * volumeScaleHeight;
                break
            }else {
                start = start + volumeScaleHeight;
                before = range[i];
            }
        }
        if(start){
            start = Math.floor(start) + 0.5
        }

        return start ;
    }
     init(){
        const ctx= this.ctx;

        this.count = Math.floor((this.width - 150) / (this.barWidth * 2) ) * 2;


        let range = this.range;
        ctx.beginPath();
        ctx.moveTo(X + 50, Y+10);
        ctx.strokeStyle = '#404040'
        ctx.lineTo(this.width - 19.5,Y+10);
        ctx.stroke();

        this.renderRange(range);

    }
    reset(){
        this.ctx.clearRect(0, 0, this.width, this.height);
        this.resetDepthHistory();
        this.rendered = false;
        this.data = [];
        this.start = 0;
        this.currentPrice = undefined;
        this.args = null;
        this.buyIndex = undefined;
        this.askIndex = undefined;
        this.lowerLimitindex = undefined;
        this.UpperLimitindex = undefined;
        this.placeOrder = [];
        this.traded = {};
        this.depthRenderId = 0;
        this.init();
    }
    resetDepthHistory(){
        if(!(this.buyDepthHistory instanceof Map)){
            this.buyDepthHistory = new Map();
        }else{
            this.buyDepthHistory.clear();
        }
        if(!(this.askDepthHistory instanceof Map)){
            this.askDepthHistory = new Map();
        }else{
            this.askDepthHistory.clear();
        }
        this.depthHistorySequence = 0;
        this.depthRenderId = 0;
        if(Array.isArray(this.data)){
            this.data.forEach(item => {
                delete item.buyDepthVolume;
                delete item.buyDepthRenderId;
                delete item.askDepthVolume;
                delete item.askDepthRenderId;
                delete item.volum;
                delete item.type;
            });
        }
    }
    setStep(step){
        const normalizedStep = Number(step);
        if(!Number.isFinite(normalizedStep) || normalizedStep <= 0){
            throw new TypeError('行情价格步长必须是大于 0 的数字');
        }
        this.step = normalizedStep;
        this.decimal = (String(step).split('.')[1] || '').length;
        this.reset();
        return this.step;
    }
    setColor(type){
        if(type){
            VALUECOLOR = {
                buy: '#ef302d',
                ask: '#0f65a1',
                buy1: '#b31529',
                ask1: '#10559a',
                deficit: '#0000ff',
                profit: '#ff0000',
                hold: '#00ff00',
                limit: '#EF2E2E',
                low: '#00ff00',
                high: "#ffff00",
                order: '#fffbf0',
                orderBuy: '#ff0000',
                orderSell: '#ff0000'
            }
        }else{


             VALUECOLOR = {
                buy: '#ffc8e6',
                ask: '#b4dcc8',
                buy1: '#ffafc8',
                ask1: '#a0dcb4',
                deficit: '#0000ff',
                profit: '#ff0000',
                hold: '#00ff00',
                limit: '#EF2E2E',
                low: '#00ff00',
                 high: "#ffff00",
                 order: 'red',
                 orderBuy: '#ff0000',
                 orderSell: '#ff0000'
            }
        }


    }
    initRange(){


        let {volumeScaleHeight, volumeScaleType, volumeScaleCount, volumeScaleTick, height} = this;
        let baseRange = null;

        switch(volumeScaleType){
            case 0:
                volumeScaleCount = Math.floor((height - 100)/volumeScaleHeight)
                break;
            case 2:
                volumeScaleCount = Math.floor((height - 100)/volumeScaleHeight)
                baseRange = [10, 20, 30, 50, 100, 200, 400, 500, 1000, 2000, 3000, 4000, 5000].slice(0, volumeScaleCount);
                break;
            case 3:
                baseRange = [10, 20, 30, 50, 100, 200, 400, 500, 1000, 2000, 3000, 4000, 5000].slice(0, volumeScaleCount);
        }
        if(!baseRange){
            baseRange = [];
            for(let i = 1; i <= volumeScaleCount; i++){
                baseRange.push(i*volumeScaleTick)
            }
        }
        return baseRange
    }
     renderRange(range){

        const ctx= this.ctx;
        ctx.textAlign = 'right'
        ctx.font= '12px 宋体';
        ctx.fillStyle= FONTCOLOR;


        let {volumeScaleHeight, width} = this;
        let start = 30
        const _Y = Y + volumeScaleHeight;
        ctx.save();


        range.forEach(e => {
            ctx.fillText(e.toString(), X - 10, _Y + start + 5);
            ctx.beginPath();
            ctx.strokeStyle = '#404040'
            ctx.moveTo(X, _Y + start);
            ctx.lineTo(X+ 50 , _Y + start);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(width - 30, _Y + start);
            ctx.lineTo(width - 5 , _Y + start);
            ctx.stroke();
            start = start + volumeScaleHeight;
        });
        ctx.restore()
    }
    resize( width, height){

        const ctx= this.ctx;
        this.width = width;
        this.height = height;
        ctx.width = width;
        ctx.height = height;
        this.range = this.initRange()
        this.init();

        if(!this.currentPrice){
          this.currentPrice = this.args?.AskPrice1;
        }
        this.initData(this.currentPrice);
        this.renderPrice()
    }
     initData(price){
         if(!price || price > Number.MAX_SAFE_INTEGER) return;

        const count = this.count / 2;
        const decimal = this.decimal;
        const data = []

        data.push({
            price: price.toFixed(decimal)
        })
        for(let i = 1; i <= count; i++ ){

            data.push({
                price: (price + this.step * i).toFixed(decimal)
            })
            data.unshift({
                price: (price - this.step * i).toFixed(decimal)
            })
        }
        if(this.data.length){
            this.getindex(data[data.length - 1].price);
            this.getindex(data[0].price)
            this.start = this.getindex(price, true) - count;
        }else {
            this.data = data;
        }

    }
    renderBakcground(){
        const ctx = this.ctx;
        const y = Y + 30;
        const _x = X + 50.5;
        const start = this.start;
        ctx.clearRect(_x-2 , y - 4 ,this.width - 30 - _x, this.height);
        const barWidth = this.barWidth;

        let buyIndex = this.buyIndex - start;

        if(buyIndex < 0) {
            buyIndex = 0;
        }
        if( this.buyIndex === this.lowerLimitindex){
            buyIndex = buyIndex -1
        }
        let askIndex = this.askIndex - start;
        if(askIndex < 0) {
            askIndex = 0;
        }

        if( this.askIndex === this.UpperLimitindex){
            askIndex = askIndex +1
        }

        if(askIndex  > this.count || askIndex === 0) {
            askIndex = this.count ;
        }

        ctx.fillStyle = BUYBACKGROUND;
        ctx.fillRect(_x, y, buyIndex *barWidth + barWidth,this.height);
        ctx.fillStyle = ASKBACKGROUND;
        ctx.fillRect(_x + askIndex *barWidth, y, this.width- _x - askIndex *barWidth - 30 , this.height);
        if(this.buyIndex === this.askIndex){
            const sharedIndex = this.buyIndex - start;
            if(sharedIndex >= 0 && sharedIndex <= this.count){
                const sharedX = _x + sharedIndex * barWidth;
                const buyWidth = Math.floor(barWidth / 2);
                ctx.fillStyle = BUYBACKGROUND;
                ctx.fillRect(sharedX, y, buyWidth, this.height);
                ctx.fillStyle = ASKBACKGROUND;
                ctx.fillRect(
                    sharedX + buyWidth,
                    y,
                    barWidth - buyWidth,
                    this.height
                );
            }
        }
        for(let i = start; (i-start) <= this.count; i ++ ){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            const { price } = this.data[i];
            const  x = X + 50 + (i - start) * barWidth;
            const y = Y + 10;
            if((price * Math.pow(10, this.decimal)).toFixed()% (this.step * Math.pow(10, this.decimal + 1)) ===0){
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(x, y + 20);
                ctx.setLineDash([1, 2])
                ctx.lineTo(x, this.height);
                ctx.stroke();
                ctx.restore()
            }

        }

    }
    renderPrice(){

        const start = this.start;
        const ctx = this.ctx;
        ctx.fillStyle= FONTCOLOR;
        ctx.textAlign = 'left'
        ctx.clearRect(100 , 0 ,this.width ,Y);
        ctx.clearRect(100 , Y+10 ,this.width ,Y+6);
        const barWidth = this.barWidth;
        for(let i = start; (i-start) <= this.count; i ++ ){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            const { price } = this.data[i];
            const  x = X + 50 + (i - start) * barWidth;
            const y = Y + 10;
            if((price * Math.pow(10, this.decimal)).toFixed() % (this.step * Math.pow(10, this.decimal + 1)) ===0){
                ctx.save();
                ctx.fillText(price, x , 20);
                ctx.beginPath();
                ctx.moveTo(x, y );
                ctx.lineTo(x, y + 6);
                ctx.stroke();
                ctx.restore()
            }else{
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x, y + 3);
                ctx.stroke();
            }

        }
    }
    getDepthHistory(side){
        const property = side === 'buy'
            ? 'buyDepthHistory'
            : 'askDepthHistory';
        if(!(this[property] instanceof Map)){
            this[property] = new Map();
        }
        return this[property];
    }
    syncDepthHistory(side, entries, renderId){
        if(this.depthRetentionMode !== 'history') return;

        const history = this.getDepthHistory(side);
        const currentEntries = new Map();
        entries.forEach(entry => {
            const price = Number(entry?.price);
            if(!Number.isFinite(price)) return;
            currentEntries.set(String(entry.price), entry);
        });

        if(currentEntries.size){
            const prices = Array.from(currentEntries.keys(), Number);
            const lowestPrice = Math.min(...prices);
            const highestPrice = Math.max(...prices);
            history.forEach((_entry, priceKey) => {
                const price = Number(priceKey);
                if(
                    price >= lowestPrice &&
                    price <= highestPrice &&
                    !currentEntries.has(priceKey)
                ){
                    history.delete(priceKey);
                }
            });
        }

        currentEntries.forEach((entry, priceKey) => {
            if(!(Number(entry.volume) > 0)){
                history.delete(priceKey);
                return;
            }
            history.delete(priceKey);
            history.set(priceKey, {
                price: priceKey,
                volume: entry.volume,
                renderId,
                sequence: ++this.depthHistorySequence
            });
        });
    }
    trimDepthHistory(){
        if(this.depthRetentionMode !== 'history') return;

        const buyHistory = this.getDepthHistory('buy');
        const askHistory = this.getDepthHistory('ask');
        const configuredLimit = Math.floor(Number(this.maxHistoricalDepthEntries));
        const limit = Number.isFinite(configuredLimit) && configuredLimit > 0
            ? configuredLimit
            : 10000;
        while(buyHistory.size + askHistory.size > limit){
            const oldestBuy = buyHistory.entries().next().value;
            const oldestAsk = askHistory.entries().next().value;
            if(!oldestAsk || (
                oldestBuy &&
                oldestBuy[1].sequence <= oldestAsk[1].sequence
            )){
                buyHistory.delete(oldestBuy[0]);
            }else{
                askHistory.delete(oldestAsk[0]);
            }
        }
    }
    getDepthPoint(depthItem, side){
        if(this.depthRetentionMode === 'history'){
            const entry = this.getDepthHistory(side).get(String(depthItem.price));
            if(!entry || !(Number(entry.volume) > 0)) return null;
            return {
                volume: entry.volume,
                current: entry.renderId === this.depthRenderId
            };
        }

        const renderId = depthItem[`${side}DepthRenderId`];
        const volume = depthItem[`${side}DepthVolume`];
        if(renderId !== this.depthRenderId || !(Number(volume) > 0)) return null;
        return {volume, current: true};
    }
    renderVolume(){
        const ctx = this.ctx;

        const y = Y + 30;
        const _x = X + 50.5;
        const buyIndex = this.buyIndex;
        const askIndex = this.askIndex;
        const barWidth = this.barWidth;
        const originalAlpha = Number.isFinite(ctx.globalAlpha)
            ? ctx.globalAlpha
            : 1;
        const configuredHistoricalAlpha = Number(this.historicalDepthOpacity);
        const historicalAlpha = Number.isFinite(configuredHistoricalAlpha)
            ? Math.min(1, Math.max(0, configuredHistoricalAlpha))
            : 0.5;
        const drawDepthBar = (point, x, width, color) => {
            ctx.globalAlpha = point.current
                ? originalAlpha
                : originalAlpha * historicalAlpha;
            ctx.fillStyle = color;
            ctx.fillRect(
                x,
                y,
                width,
                Chart.getHeight(this.range, point.volume, this.volumeScaleHeight)
            );
            ctx.globalAlpha = originalAlpha;
        };
        let askX,askY, askV, buyX,buY, buyV;
        for(let i = this.start; (i-this.start)  <= this.count; i ++ ){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            const depthItem = this.data[i];
            let buyPoint = this.getDepthPoint(depthItem, 'buy');
            let askPoint = this.getDepthPoint(depthItem, 'ask');
            if(buyPoint && i > buyIndex){
                buyPoint = null;
            }
            if(askPoint && i < askIndex){
                askPoint = null;
            }
            if(buyPoint && askPoint){
                const x = _x + (i-this.start) * barWidth;
                const availableWidth = Math.max(2, barWidth - 1);
                const buyWidth = Math.floor(availableWidth / 2);
                const askWidth = availableWidth - buyWidth;
                drawDepthBar(
                    buyPoint,
                    x,
                    buyWidth,
                    i === buyIndex ? VALUECOLOR['buy1'] : VALUECOLOR['buy']
                );
                drawDepthBar(
                    askPoint,
                    x + buyWidth,
                    askWidth,
                    i === askIndex ? VALUECOLOR['ask1'] : VALUECOLOR['ask']
                );
                if(i === buyIndex && buyPoint.current){
                    buyX = x + buyWidth - this.volumeXOffset;
                    buY = this.volumeYOffset > 0
                        ? y + this.volumeYOffset
                        : y;
                    buyV = buyPoint.volume;
                }
                if(i === askIndex && askPoint.current){
                    askX = x + buyWidth + this.volumeXOffset;
                    askY = this.volumeYOffset < 0
                        ? y - this.volumeYOffset
                        : y;
                    askV = askPoint.volume;
                }
                continue;
            }
            if(!buyPoint && !askPoint){
                continue;
            }
            const point = buyPoint || askPoint;
            const type = buyPoint ? 'buy' : 'ask';
            let color = VALUECOLOR[type];
            if(i === buyIndex && type === 'buy'){
                color = VALUECOLOR['buy1'];
            }else if(i === askIndex && type === 'ask'){
                color = VALUECOLOR['ask1'];
            }

            const  x = _x + (i-this.start) * barWidth;
            drawDepthBar(point, x, barWidth - 1, color);

            if(point.current && i === askIndex && type === 'ask'){
                askX = x + this.volumeXOffset;
                askY = y;
                if(this.volumeYOffset < 0){
                    askY = askY - this.volumeYOffset
                }
                askV = point.volume;
            } else if(point.current && i === buyIndex && type === 'buy'){
                buyX = x + barWidth - this.volumeXOffset;
                buY = y;
                buyV = point.volume
                if(this.volumeYOffset > 0){
                    buY = buY + this.volumeYOffset
                }
            }

        }

        ctx.globalAlpha = originalAlpha;
        ctx.save();
        ctx.font= '12px 宋体';
        ctx.fillStyle= FONTCOLOR;
        if(buyV){
            buyV = buyV
            ctx.textAlign='right'
            ctx.fillText(buyV, buyX , buY + 10);

        }
        if(askV){
            ctx.textAlign='left'
            ctx.fillText(askV, askX , askY + 10);
        }
        ctx.stroke();
        ctx.restore();
    }
    clearData(startPrice, endPrice){
        if(!startPrice || !endPrice) return;
        let start = this.getindex(startPrice, true);
        if(start < 0) start = 0
        let end = this.getindex(endPrice, true);
        if(end > this.data.length -1) end = this.data.length -1;
        for(let i = start; i < end; i++){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            this.data[i].volum = 0;
        }
    }
    pushData(count){
        let {price} = this.data[this.data.length-1];
        price = parseFloat(price)
        const decimal = this.decimal
        if(count < 5){
            count = 5
        }
        for(let i =1; i <= count; i++ ){
            this.data.push({
                price: (price+ i* this.step).toFixed(decimal)
            })
        }
        this.start = this.start + count;

    }
    unshiftData(count){
        let {price} = this.data[0];
        price = parseFloat(price)
        const decimal = this.decimal
        if(count < 5){
            count = 5
        }
        for(let i =1; i <= count; i++ ){
            this.data.unshift({
                price:(price- i* this.step).toFixed(decimal)
            })
        }
        this.start = 0;
        return count
    }
    getindex(price, pure){
        // console.log(price, pure);
        if(Math.abs(price) > Number.MAX_SAFE_INTEGER){
           return undefined
        }
        if(!price) return this.start
        let index = Math.round((price - this.data[0].price) / this.step);
        if(pure){
            return index;
        }
        let barToBorder = parseInt(this.barToBorder);

        let offset = 0;
        let rerender = false;

        if(index > this.data.length - barToBorder){
             offset = index - this.data.length + barToBorder;
            this.pushData(offset);
            rerender = true;
        }
        if(index < barToBorder){
            offset = barToBorder - index;
            const count = this.unshiftData(offset)

            rerender = true;
            index = index + count;
        }
        const start = this.start;
        if(index < start + barToBorder){
            offset =  barToBorder+start - index;
            let min = offset;

            this.start = start - min
            rerender = true;
        }
        if(index > start + this.count - barToBorder){
            offset = index - start- this.count+barToBorder;
            let min = offset;

            this.start = start + min;
            rerender = true;
        }

        if(rerender){
            this.renderPrice();
        }

        return index;
    }
    renderTime(time){
        const ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = FONTCOLOR;
        ctx.clearRect(0,0, 50, 20);
        ctx.fillText(time, 0, 20);
        ctx.restore();
    }
    renderCurrentPirce(price, volume){
        const ctx =this.ctx;
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = FONTCOLOR;

        // console.log(volume, this.volume)
        if(this.volume < volume){
            ctx.strokeStyle = '#ffff00';
        };
        const barWidth = this.barWidth;
        const x = X + 50 + (this.getindex(price, true) - this.start) * barWidth;

        ctx.clearRect(0,20,this.width,10)
        ctx.beginPath();
        ctx.moveTo(x, 21);
        ctx.lineTo(x+barWidth, 21);
        ctx.lineTo(x+barWidth, 29);
        ctx.lineTo(x, 29);
        ctx.lineTo(x, 21);
        ctx.stroke()
        ctx.restore();
        this.currentPrice = price;
        this.volume=volume
    }
    renderPlaceOrder(){
        if(this.data.length===0) return;

        const pricearray = this.placeOrder.reduce((a, b) => {
            const status = String(b.status || '').toUpperCase();
            const price = Number(b.price) > 0 ? Number(b.price) : Number(b.stopPrice);
            const volume = Math.max(0, Number(b.origQty) - Number(b.executedQty));
            const side = String(b.side || '').toUpperCase();

            if(!['NEW', 'PARTIALLY_FILLED'].includes(status) || !Number.isFinite(price) ||
                !Number.isFinite(volume) || volume <= 0 || !['BUY', 'SELL'].includes(side)){
                return a;
            }

            const item = a.find(e => e.price === price && e.side === side)
            if(item){
                item.volume = item.volume + volume
            }else{
                a.push({
                    price,
                    volume,
                    side
                })
            }
            return a;
        },[])
        const priceGroups = Array.from(
            pricearray.reduce((groups, item) => {
                const existing = groups.get(item.price) || [];
                existing.push(item);
                groups.set(item.price, existing);
                return groups;
            }, new Map()).entries(),
            ([price, orders]) => ({price, orders})
        );
        const ctx =this.ctx;
        ctx.save();

        const y = Y + 30 ;
        const _x = X + 50.5;
        const {barWidth, volumeScaleHeight, range} = this;
        let _volume = [0, 0];
        let visibleCount = 0;

        pricearray.forEach(({volume, side}) => {
            const direction = side === 'BUY' ? 0 : 1;
            _volume[direction] = _volume[direction] + volume;
        });
        priceGroups.forEach(({price, orders}) => {
            const index = this.getindex(price, true);
            if(index < this.start || index > this.start + this.count)return;
            const  x = _x + (index-this.start) * barWidth;
            const availableWidth = Math.max(2, barWidth - 1);
            const drawWidth = orders.length > 1
                ? Math.floor(availableWidth / orders.length)
                : availableWidth;
            let offsetX = 0;
            orders.forEach(({volume, side}, orderIndex) => {
                const width = orderIndex === orders.length - 1
                    ? availableWidth - offsetX
                    : drawWidth;
                const height = Math.max(
                    4,
                    Chart.getHeight(range, volume, volumeScaleHeight)
                );
                ctx.fillStyle = side === 'BUY'
                    ? VALUECOLOR.orderBuy
                    : VALUECOLOR.orderSell;
                ctx.fillRect(x + offsetX, y, width, height);
                offsetX += width;
            });
            visibleCount += 1;

        })
        this.holdVolume = _volume;
        this.visiblePlaceOrderCount = visibleCount;
        this.totalPlaceOrderCount = priceGroups.length;
        // console.log(this.placeOrder, pricearray)
        ctx.restore()
    }
    renderTradeOrder(){
        const _x = X + 50;
        const _y = Y + 17;
        const {price, direction, amount} = this.traded;
        const {ctx , width, start, barWidth} = this;

        if(!this.data.length)return;
        ctx.clearRect(0, _y - 1 , width, 10)
        if(direction && amount){
            ctx.save();

            const index = this.getindex(price, true)- start;
            let cindex;
            if(direction === '0'){
                cindex = this.buyIndex;

            }else{
                cindex = this.askIndex;
            }

            cindex = cindex - start;
            let begin, end, _direction;
            if(index <= cindex){
                begin = index;
                end = cindex;
                _direction = '0';
            }else{
                begin = cindex;
                end = index;
                _direction = '1';
            };
            let color
            if(_direction === direction){
                color = VALUECOLOR.profit;
            }else{
                color = VALUECOLOR.deficit;
            }
            if(begin === end){
                color = VALUECOLOR.hold;
            }
            ctx.fillStyle = color;
            ctx.fillRect(_x + begin * barWidth, _y , (end - begin + 1) * barWidth, 7);
            ctx.fillStyle = '#fff';
            ctx.fillText(amount, _x+cindex * barWidth + 5, _y + 8)
            ctx.restore()
        }
    }
    renderHighandLow(){
        if(this.data.length === 0) return;
        const lowindex = this.getindex(this.LowestPrice, true);
        const highindex = this.getindex(this.HighestPrice, true);
        const {start, ctx, count, barWidth, height} = this;
        let lowX = (lowindex - start) * barWidth;
        let HighX = (highindex - start) * barWidth
        if(lowindex < start || lowindex > start + count){
            lowX =  - 50;
        }
        if(highindex > start + count || highindex < start){
            HighX = this.width - X - 51
        }
        ctx.clearRect(X -1, Y + 29 ,2 , height - 10);
        ctx.clearRect( this.width - 2, Y + 29 ,2 , height - 10);
        const offset= X + 50;
        ctx.save()
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.strokeStyle = VALUECOLOR.low
        ctx.moveTo(lowX+offset, Y + 30);
        ctx.lineTo(lowX+offset,height - 10);
        ctx.stroke();
        ctx.beginPath();

        ctx.strokeStyle = VALUECOLOR.high
        ctx.moveTo(HighX+offset, Y + 30);
        ctx.lineTo(HighX+offset,height - 10);
        ctx.stroke();
        ctx.restore();
        this.renderLimited()
    }
    renderLimited(){

        const lowindex = this.lowerLimitindex
        const highindex =  this.UpperLimitindex;

        const offset= X + 49.5;
        const {start, ctx, count, barWidth, height} = this;
        ctx.save()
        ctx.strokeStyle = VALUECOLOR.limit;
        ctx.lineWidth = 2
        function render(index){
            if(start<=index  && index <=start+count){
                const _X = (index - start) * barWidth;
                ctx.beginPath();
                ctx.moveTo(_X+offset, Y + 30);
                ctx.lineTo(_X+offset,height - 10);
                ctx.stroke();
            }
        };
        render(lowindex);
        render(highindex);
        ctx.restore();
    }
    renderseconds(){
        const time = new Date().getMilliseconds();
        const ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = FONTCOLOR;
        const width = this.width - 20
        ctx.clearRect(width,0, 20, 10);
        ctx.fillText(time, width, 10);
        ctx.restore();
    }
    render(arg){

        if(!arg.LastPrice){
            arg.LastPrice = arg.AskPrice1 || arg.BidPrice1
        }
        if(arg.LastPrice > Number.MAX_SAFE_INTEGER) return
        if(this.data.length === 0) {
            this.initData(arg.LastPrice);
            if(!this.data.length) return
            this.renderPrice();
        }


        this.args= arg
        // this.renderTime(arg.UpdateTime)
        // console.log(arg)
        const depthLevelCount = Math.min(
            20,
            Math.max(1, Math.floor(Number(arg.DepthLevels) || 5))
        );
        this.depthRenderId += 1;
        const depthRenderId = this.depthRenderId;
        const depthFrame = {
            buy: [],
            ask: []
        };
        const deepestBid = arg[`BidPrice${depthLevelCount}`];
        const deepestAsk = arg[`AskPrice${depthLevelCount}`];
        if(deepestBid && deepestBid <= Number.MAX_SAFE_INTEGER){
            this.clearData(deepestBid, arg.BidPrice1 );
        }
        if(deepestAsk && deepestAsk <= Number.MAX_SAFE_INTEGER){
            this.clearData(arg.AskPrice1, deepestAsk);
        }
        let pauseAsk, pasuseBuy;
        for(let i=depthLevelCount; i> 0; i--){
            let buyPirce = arg[`BidPrice${i}`];
            let buyIndex ;
            const flag = this.rendered ? i > 1 : i < depthLevelCount;

            if(buyPirce && !pasuseBuy){
                buyIndex = this.getindex(buyPirce, flag)
                const buyData = this.data[buyIndex];
                if(buyData){
                    buyData.volum = arg[`BidVolume${i}`];
                    buyData.type = 'buy';
                    buyData.buyDepthVolume = arg[`BidVolume${i}`];
                    buyData.buyDepthRenderId = depthRenderId;
                    depthFrame.buy.push({
                        price: buyData.price,
                        volume: arg[`BidVolume${i}`]
                    });
                }
            }


            const askPirce = arg[`AskPrice${i}`] ;
            let askIndex;
            if(askPirce && !pauseAsk){
                askIndex = this.getindex(askPirce, flag)
                const askData = this.data[askIndex];
                if(askData){
                    askData.volum = arg[`AskVolume${i}`];
                    askData.type = 'ask';
                    askData.askDepthVolume = arg[`AskVolume${i}`];
                    askData.askDepthRenderId = depthRenderId;
                    depthFrame.ask.push({
                        price: askData.price,
                        volume: arg[`AskVolume${i}`]
                    });
                }
            }

            if(i === 1) {
                if(!buyPirce || buyPirce>= Number.MAX_SAFE_INTEGER || buyPirce <= Number.MIN_SAFE_INTEGER){
                    buyIndex = askIndex
                    pasuseBuy = true;
                }
                if(!askPirce  || askPirce>= Number.MAX_SAFE_INTEGER || askPirce <= Number.MIN_SAFE_INTEGER){
                    askIndex = buyIndex;
                    pauseAsk = true;

                }
                this.buyIndex = buyIndex;
                this.askIndex = askIndex;

            }
        }
        this.syncDepthHistory('buy', depthFrame.buy, depthRenderId);
        this.syncDepthHistory('ask', depthFrame.ask, depthRenderId);
        this.trimDepthHistory();
        this.lowerLimitPrice = arg.LowerLimitPrice;
        this.UpperLimitPrice = arg.UpperLimitPrice;
        this.lowerLimitindex = this.getindex(arg.LowerLimitPrice, true);
        this.UpperLimitindex = this.getindex(arg.UpperLimitPrice, true);
        if(!arg.BidPrice1){

            this.buyIndex = this.lowerLimitindex
        }
        if(!arg.AskPrice1){

            this.askIndex = this.UpperLimitindex
        }
        this.LowestPrice = arg.LowestPrice;
        this.HighestPrice = arg.HighestPrice;

        this.renderBakcground();

        this.renderVolume();
        // this.renderHighandLow()


        // this.renderCurrentPirce(arg.LastPrice, arg.Volume);
        this.renderPlaceOrder();
        this.renderTradeOrder();
        this.rendered= true;
        // this.renderseconds()


    }
}

    Chart.PLOT_LEFT = X + 50;
    Chart.PLOT_TOP = Y + 30;
    Chart.PLOT_BOTTOM_PADDING = 10;

    return { Chart };
});
